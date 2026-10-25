package io.github.getpaperplane.paperplane.reviewdiff

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.text.Spanned
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReviewDiffCodeLayoutTest {
  private val paint = TextPaint().apply {
    color = Color.WHITE
    textSize = 24f
    typeface = Typeface.MONOSPACE
  }

  @Test
  fun unicodeAndTabsFitWithoutSplittingClusters() {
    val fixtures = listOf("漢字表示", "e\u0301", "👨‍👩‍👧‍👦", "مرحبا بالعالم ", "\tvalue ")
    for (fixture in fixtures) {
      val text = fixture.repeat(40)
      for (width in listOf(180, 280, 420)) {
        val layout = requireNotNull(createCodeLines(text, paint, width).nativeLayout)
        assertInkFits(layout, width, fixture)
        assertLinesFit(layout, fixture, width)
      }
    }
  }

  private fun assertLinesFit(layout: android.text.StaticLayout, fixture: String, width: Int) {
    val text = layout.text
    for (line in 0 until layout.lineCount) {
      if (!fixture.contains('\t')) {
        assertTrue("$fixture line $line at $width", layout.getLineMax(line) <= width + 1)
      }
      val start = layout.getLineStart(line)
      assertTrue(start == 0 || !Character.isLowSurrogate(text[start]))
      if (fixture == "👨‍👩‍👧‍👦" || fixture == "e\u0301") {
        assertEquals(0, start % fixture.length)
      }
    }
  }

  private fun assertInkFits(layout: android.text.StaticLayout, width: Int, fixture: String) {
    val bitmap = Bitmap.createBitmap(width + 40, layout.height, Bitmap.Config.ARGB_8888)
    layout.draw(Canvas(bitmap))
    for (x in width + 1 until bitmap.width) {
      for (y in 0 until bitmap.height) {
        assertEquals("$fixture ink outside width $width", 0, Color.alpha(bitmap.getPixel(x, y)))
      }
    }
    bitmap.recycle()
  }

  @Test
  fun asciiSegmentsCoverTheWholeLineAndFit() {
    val text = "const value = 123; ".repeat(100)
    val lines = createCodeLines(text, paint, 280)
    val pieces = lines.starts.indices.map {
      text.substring(lines.starts[it], lines.end(it, text.length))
    }
    assertEquals(text, pieces.joinToString(""))
    assertTrue(pieces.all { paint.measureText(it) <= 280 })
  }

  @Test
  fun changingCommentHeightReusesCodeButWidthAndContentInvalidateIt() {
    val cache = CodeLayoutCache()
    val row = row("漢字".repeat(100))
    val comment = row.copy(kind = "comment", id = "comment", content = "", commentText = "Before")
    val style = DiffStyle.defaults(1f).copy(wordWrap = true)
    val theme = DiffTheme.fallback("light")
    val first = cache.layout(
      listOf(row, comment),
      emptyMap(),
      paint,
      style,
      theme,
      280
    ).lines(row.id)
    val second = cache.layout(
      listOf(row, comment.copy(commentText = "After")),
      emptyMap(),
      paint,
      style,
      theme,
      280,
    ).lines(row.id)
    assertSame(first, second)
    val narrow = cache.layout(listOf(row), emptyMap(), paint, style, theme, 180).lines(row.id)
    assertNotSame(first, narrow)
    assertTrue(narrow.extraHeight > first.extraHeight)
    val edited = cache.layout(
      listOf(row.copy(content = "短い")),
      emptyMap(),
      paint,
      style,
      theme,
      180
    ).lines(row.id)
    assertTrue(edited.extraHeight < narrow.extraHeight)
    assertEquals(
      0,
      cache.layout(
        listOf(row),
        emptyMap(),
        paint,
        style.copy(wordWrap = false),
        theme,
        180
      ).extraHeight(row.id)
    )
  }

  @Test
  fun rowHeightsPreserveHeadersNoticesAndCommentExpansion() {
    val style = DiffStyle.defaults(2f)
    val line = row("value")
    val wrap = CodeWrapLayout.NONE
    assertEquals(
      style.fileHeaderHeightPx.toInt(),
      wrap.rowHeight(line.copy(kind = "file"), style, emptySet(), 2f)
    )
    assertEquals(88, wrap.rowHeight(line.copy(kind = "comment"), style, setOf(line.id), 2f))
    assertEquals(248, wrap.rowHeight(line.copy(kind = "comment"), style, emptySet(), 2f))
    assertEquals(style.rowHeightPx.toInt(), wrap.rowHeight(line, style, emptySet(), 2f))
    assertEquals(
      88,
      wrap.rowHeight(line.copy(kind = "notice"), style.copy(rowHeightPx = 10f), emptySet(), 2f)
    )
    assertEquals(
      200,
      wrap.rowHeight(line.copy(kind = "notice"), style.copy(rowHeightPx = 100f), emptySet(), 2f)
    )
    assertEquals(
      1,
      wrap.rowHeight(line.copy(kind = "unknown"), style.copy(rowHeightPx = 0f), emptySet(), 2f)
    )
  }

  @Test
  fun highlightsUseNativeTextRangesAndSurviveSyntaxArrival() {
    val cache = CodeLayoutCache()
    val row = row("漢字".repeat(30)).copy(wordDiffRanges = listOf(DiffWordDiffRange(3, 21)))
    val style = DiffStyle.defaults(1f).copy(wordWrap = true)
    val theme = DiffTheme.fallback("light")
    val wrap = cache.layout(listOf(row), emptyMap(), paint, style, theme, 180)
    val initial = wrap.lines(row.id)
    val tokens = mapOf(row.id to listOf(DiffToken(row.content, 0xff008800.toInt(), 0)))
    assertEquals(
      "Color-only patches must not rebuild offsets",
      false,
      cache.patchTokens(tokens, paint),
    )
    val highlighted = wrap.lines(row.id)
    assertNotSame(initial, highlighted)
    val text = requireNotNull(highlighted.nativeLayout).text as Spanned
    assertEquals(
      0xff008800.toInt(),
      text.getSpans(0, text.length, ForegroundColorSpan::class.java).single().foregroundColor,
    )
    val span = text.getSpans(0, text.length, BackgroundColorSpan::class.java).single()
    assertEquals(3, text.getSpanStart(span))
    assertEquals(21, text.getSpanEnd(span))
  }

  @Test
  fun patchesVisitOnlyAffectedRowsAndKeepUnrelatedLayouts() {
    val cache = CodeLayoutCache()
    val rows = CountingRows(List(1_000) { row("value").copy(id = "row-$it") })
    val style = DiffStyle.defaults(1f).copy(wordWrap = true)
    val theme = DiffTheme.fallback("light")
    val wrap = cache.layout(rows, emptyMap(), paint, style, theme, 180)
    val before = rows.map { wrap.lines(it.id) }
    val patch = (0 until 4).associate { index ->
      "row-$index" to listOf(DiffToken("value", Color.GREEN, 0))
    }
    val workerSnapshot = cache.copyForPreparation()
    rows.reads = 0
    assertEquals(false, cache.patchTokens(patch, paint))
    assertEquals("A small token patch must not scan the document", 0, rows.reads)
    rows.forEachIndexed { index, row ->
      if (index < 4) {
        assertNotSame(before[index], wrap.lines(row.id))
      } else {
        assertSame(before[index], wrap.lines(row.id))
      }
    }
    val unchangedWorker = workerSnapshot.layout(rows, emptyMap(), paint, style, theme, 180)
    assertSame(
      "UI patches must not mutate a worker snapshot",
      before[0],
      unchangedWorker.lines("row-0"),
    )
    val current = wrap.lines("row-0")
    assertEquals(false, cache.patchTokens(patch, paint))
    assertSame("Repeated identical tokens need no layout", current, wrap.lines("row-0"))
    assertEquals(false, cache.patchTokens(emptyMap(), paint))
    assertEquals(false, cache.patchTokens(mapOf("absent" to emptyList()), paint))

    // Compare the old full-layout path with patching the same warm document.
    rows.reads = 0
    cache.layout(rows, patch, paint, style, theme, 180)
    val fullScanReads = rows.reads
    assertEquals(1_000, fullScanReads)
    rows.reads = 0
    cache.patchTokens(mapOf("row-0" to emptyList()), paint)
    assertEquals(0, rows.reads)
    println("Android row visits: full token update $fullScanReads -> patch ${rows.reads}")
  }

  @Test
  fun patchedNativeFontStylesAndHeightsMatchAFullLayoutAndCanBeReset() {
    val cache = CodeLayoutCache()
    val serif = TextPaint(paint).apply { typeface = Typeface.SERIF }
    val row = row("é".repeat(30)).copy(wordDiffRanges = listOf(DiffWordDiffRange(3, 21)))
    val style = DiffStyle.defaults(1f).copy(wordWrap = true)
    val theme = DiffTheme.fallback("light")
    val bold = TextPaint(serif).apply { typeface = Typeface.create(Typeface.SERIF, Typeface.BOLD) }
    val width = ((serif.measureText(row.content) + bold.measureText(row.content)) / 2f).toInt()
    val wrap = cache.layout(listOf(row), emptyMap(), serif, style, theme, width)
    val initial = wrap.lines(row.id)
    val patch = mapOf(row.id to listOf(DiffToken(row.content, Color.GREEN, 2)))
    val changed = cache.patchTokens(patch, serif)
    val patched = wrap.lines(row.id)
    val full = CodeLayoutCache().layout(listOf(row), patch, serif, style, theme, width)
    val base = style.rowHeightPx.toInt()
    assertEquals(full.rowHeight(row.id, base), wrap.rowHeight(row.id, base))
    assertEquals(
      initial.firstHeight(base) + initial.extraHeight != wrap.rowHeight(row.id, base),
      changed,
    )
    assertTrue("Fixture must exercise a height-changing font patch", changed)
    val text = requireNotNull(patched.nativeLayout).text as Spanned
    assertEquals(Typeface.BOLD, text.getSpans(0, text.length, StyleSpan::class.java).single().style)
    val highlight = text.getSpans(0, text.length, BackgroundColorSpan::class.java).single()
    assertEquals(3, text.getSpanStart(highlight))
    assertEquals(21, text.getSpanEnd(highlight))
    assertTrue(cache.patchTokens(mapOf(row.id to emptyList()), serif))
    assertEquals(initial.starts.toList(), wrap.lines(row.id).starts.toList())
    assertEquals(initial.firstHeight(base) + initial.extraHeight, wrap.rowHeight(row.id, base))
    val reset = cache.layout(listOf(row), emptyMap(), serif, style, theme, width)
    assertEquals(wrap.rowHeight(row.id, base), reset.rowHeight(row.id, base))
    cache.layout(listOf(row), emptyMap(), serif, style.copy(wordWrap = false), theme, width)
    assertEquals(false, cache.patchTokens(patch, serif))
  }

  private class CountingRows(private val values: List<DiffRow>) : AbstractList<DiffRow>() {
    var reads = 0
    override val size: Int get() = values.size
    override fun get(index: Int): DiffRow {
      reads += 1
      return values[index]
    }
  }

  private fun row(content: String) = DiffRow(
    kind = "line", id = "line", fileId = "file", filePath = "test.ts", previousPath = null,
    changeType = "modified", additions = 1, deletions = 0, text = "", content = content,
    change = "add", oldLineNumber = null, newLineNumber = 1, wordDiffRanges = emptyList(),
    commentText = "", commentRangeLabel = "", commentSectionTitle = "",
  )
}
