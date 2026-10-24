# Pi

Paperplane embeds Pi through its SDK on the machine running the server. A remote client uses that server's Pi credentials and configuration, not a Pi installation on the client device.

Authenticate your model provider with Pi on the server, then enable **Pi** in Paperplane's provider settings. **Pi agent directory** selects a separate configuration directory for an instance; leave it blank for the server's default. Instances using the same directory can resume each other's sessions.

## Configuration and extensions

Pi reads global resources from `~/.pi/agent`, or `PI_CODING_AGENT_DIR`, and project resources from the thread's working directory. Global extensions, `.pi/extensions/`, and packages configured in Pi's settings run on the server with its permissions. Only start Pi threads in repositories you trust. Configuration changes take effect when the next Pi session starts.

Paperplane uses Pi's model catalog and supported reasoning levels. It does not run paid inference requests to probe model capabilities. Background text generation, such as thread titles, does not load extensions or keep session history.

## Models and extension catalog

On web, the Extensions control beside a Pi provider selector opens that instance's global catalog. On mobile, open the model settings sheet and choose Pi → Extensions. Refresh re-reads its global extensions and model catalog from the server; project-local extensions load only in their project's threads. Disabling an extension excludes its tools and models from new sessions, is saved per instance, and takes effect after running turns finish.

Use the model and reasoning pickers to choose capabilities reported by Pi. If an extension model is removed or its reasoning level is unsupported, Paperplane shows the effective selection or a startup error rather than silently keeping an unavailable choice. In provider settings, **Use Pi default** clears the thinking override.

Pi can delegate work through Paperplane's tools, including tasks that use other providers. Ask the agent to delegate a task and specify the provider or model when needed.

## Session recovery

Paperplane saves each Pi session's identity and absolute file location on the server. Sessions remain recoverable when a thread's working directory changes, provided the saved file remains accessible. Older sessions without a saved file location use Pi's working-directory lookup.

Rollback positions are saved as exact session-tree boundaries, so steering messages sent while a turn runs never count as extra turns. Threads whose history predates exact boundaries cannot roll back; start a new thread instead.

If history is missing, unreadable, empty, or belongs to another session, startup fails instead of silently starting an empty conversation. Restore the session file or storage access on the server, then retry the turn. To continue without that history, create a new thread. The original thread keeps its saved session reference for recovery.

New sessions are saved before the first prompt, so restarting before the first assistant response does not invalidate their session reference.

## Resource limits on Linux and WSL

Heavy tools such as concurrent builds and typechecks can exhaust RAM and cause disk saturation from swapping, making a remote server unreachable. In web or desktop **Settings → Providers → Pi**, or mobile **Settings → Provider accounts**, choose **Workload protection** and a shared **Workload memory (MiB)** limit. Auto enables protection on Linux or WSL hosts with 768 MiB–8 GiB RAM, a systemd user manager, and `flock`. On requires that support; Off opts out. Settings survive server restarts. If an existing instance has not picked up a change, disable and re-enable it when no threads are running.

Protected Pi shell calls run up to 4 commands at once, fewer on small hosts. Threads, instances, and Paperplane environments running as the same OS user share these slots. Calls queue only when the slots are busy. Reads, edits, and model responses do not wait for a shell slot. Shell calls have a default 600-second deadline, including queue time; the tool's timeout can override it. Parallel commands inside one shell still share its budget.

Leave workload memory at `auto` to share the host's Paperplane memory budget with agents while reserving RAM for the OS and server. Agent work can use swap up to a bound when available; only when both the RAM budget and bounded swap are exhausted does Paperplane stop the largest command. CPU use is not capped. An integer of at least 384 MiB adds a shared hard cap without swap for Pi commands and background services, capped by the host budget. When that cap is exhausted, a command and its descendants stop while Pi stays connected. The error includes the limit and peak usage when available; retry with less parallelism or split the job.

For a dev server, ask the agent to use `workload_start`, not shell `&` or `nohup`. One managed background service can run per OS user while foreground commands continue. `workload_list` shows this thread's service and its recent output; `workload_stop` stops it. A service stops when its owning session or Pi runtime closes, including after a runtime crash. Foreground calls stop hidden background descendants before releasing the slot.

`PAPERPLANE_PI_MEMORY_BUDGET_MIB` is an advanced hard-limit override without swap: it enables protection and overrides both settings, even Off. Remove it to let Settings control the policy. Use consistent settings across instances because the limit is shared. Raising a limit takes effect immediately; lowering a hard limit waits until usage falls below it and setup runs again. Existing Auto settings saved with the former 2048 MiB default now use the host budget; choose On with 2048 to retain that explicit ceiling.

This is workload management, not a security sandbox. Other providers, extension code running inside Pi, extension tools that start processes directly, and commands deliberately moved into another systemd scope are not automatically protected. Such extensions can still interrupt their Pi instance. Prefer the protected shell tools for expensive work.
