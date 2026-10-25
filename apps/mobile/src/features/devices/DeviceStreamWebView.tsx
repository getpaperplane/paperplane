import deviceStreamScript from "@getpaperplane/mobile-device-stream";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Platform, Pressable, View } from "react-native";
import { WebView } from "react-native-webview";
import type { DeviceStreamStatus } from "@getpaperplane/client-runtime/device/stream";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";

import {
  deviceStreamDocument,
  deviceStreamMessage,
  type DeviceStreamConfiguration,
} from "./device-stream-document";

export interface DeviceStreamRef {
  home: () => void;
  back: () => void;
  appSwitcher: () => void;
  rotate: () => void;
}

type NativeStreamBridge = {
  readonly ref?: Ref<DeviceStreamRef>;
  readonly onUnauthorized: () => Promise<void>;
  readonly onInputConnected: (connected: boolean) => Promise<void>;
};

export function DeviceStreamWebView({
  ref,
  ...props
}: DeviceStreamConfiguration & NativeStreamBridge) {
  const configuration = JSON.stringify({
    access: props.access,
    platform: props.platform,
    deviceId: props.deviceId,
    colors: props.colors,
  });
  return (
    <StreamWebView
      ref={ref}
      script={deviceStreamScript}
      globalName="PaperplaneDeviceStream"
      subject="device"
      configuration={configuration}
      background={props.colors.background}
      onUnauthorized={props.onUnauthorized}
      onInputConnected={props.onInputConnected}
    />
  );
}

/**
 * Hosts one generated browser script in a WebView and owns its recovery: a
 * remount per retry, one automatic remount when the WebView process dies, and
 * the bootstrap watchdog. Devices and desktops share it.
 */
export function StreamWebView({
  ref,
  script,
  globalName,
  subject,
  configuration,
  background,
  onRetry,
  ...props
}: NativeStreamBridge & {
  readonly script: string;
  readonly globalName: string;
  readonly subject: "device" | "desktop";
  readonly configuration: string;
  readonly background: string;
  /**
   * Owns user-initiated retries when provided: the stream remounts only when
   * the owner's configuration changes, so one retry is one reconnect. Without
   * it, a retry remounts locally and refreshes access through `onUnauthorized`.
   */
  readonly onRetry?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const processRetried = useRef(false);
  return (
    <DeviceStreamDocumentView
      key={`${attempt}:${configuration}`}
      ref={ref}
      script={script}
      globalName={globalName}
      subject={subject}
      configuration={configuration}
      background={background}
      onUnauthorized={props.onUnauthorized}
      onInputConnected={props.onInputConnected}
      onRetry={() => {
        processRetried.current = false;
        if (onRetry) return onRetry();
        setAttempt((attempt) => attempt + 1);
        void props.onUnauthorized();
      }}
      onStreaming={() => {
        processRetried.current = false;
      }}
      onRecoverProcess={() => {
        if (processRetried.current) return false;
        processRetried.current = true;
        setAttempt((attempt) => attempt + 1);
        void props.onUnauthorized();
        return true;
      }}
    />
  );
}

function DeviceStreamDocumentView({
  ref,
  script,
  globalName,
  subject,
  configuration,
  background,
  onUnauthorized,
  onInputConnected,
  onRetry,
  onStreaming,
  onRecoverProcess,
}: NativeStreamBridge & {
  readonly script: string;
  readonly globalName: string;
  readonly subject: "device" | "desktop";
  readonly configuration: string;
  readonly background: string;
  readonly onRetry: () => void;
  readonly onStreaming: () => void;
  readonly onRecoverProcess: () => boolean;
}) {
  const webView = useRef<WebView<object>>(null);
  const active = useRef(true);
  const failed = useRef(false);
  const [status, setStatus] = useState<DeviceStreamStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const fail = (message: string) => {
    if (!active.current || failed.current) return;
    failed.current = true;
    void onInputConnected(false);
    webView.current?.injectJavaScript(`window.${globalName}?.stop(); true;`);
    setError(message);
    setStatus("error");
  };
  // The shared transport owns video timeouts once the document acknowledges startup.
  const bootstrapTimedOut = useEffectEvent(() =>
    fail(`The ${subject} viewer could not start. Reconnect to try again.`),
  );
  useEffect(() => {
    if (started) return;
    const timer = setTimeout(bootstrapTimedOut, 15_000);
    return () => clearTimeout(timer);
  }, [started]);
  const source = useMemo(
    () => ({
      html: deviceStreamDocument(configuration, script, globalName),
      // Android WebCodecs needs a secure document; streams still use the environment's URLs.
      baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
    }),
    [configuration, script, globalName],
  );
  const command = (button: keyof DeviceStreamRef) => {
    webView.current?.injectJavaScript(
      `window.${globalName}?.command(${JSON.stringify(button)}); true;`,
    );
  };
  useImperativeHandle(ref, () => ({
    home: () => command("home"),
    back: () => command("back"),
    appSwitcher: () => command("appSwitcher"),
    rotate: () => command("rotate"),
  }));
  const resetInput = useEffectEvent(() => void onInputConnected(false));
  useLayoutEffect(() => {
    active.current = true;
    resetInput();
    const view = webView.current;
    return () => {
      active.current = false;
      view?.injectJavaScript(`window.${globalName}?.stop(); true;`);
    };
  }, []);
  const processTerminated = () => {
    if (!active.current || failed.current) return;
    void onInputConnected(false);
    if (!onRecoverProcess()) fail(`The ${subject} viewer stopped. Reconnect to try again.`);
  };
  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      <WebView<object>
        ref={webView}
        source={source}
        originWhitelist={["*"]}
        scrollEnabled={false}
        bounces={false}
        mixedContentMode="always"
        allowUniversalAccessFromFileURLs
        contentInsetAdjustmentBehavior="never"
        setSupportMultipleWindows={false}
        style={{ flex: 1, backgroundColor: background }}
        onError={() => fail(`The ${subject} viewer could not load. Reconnect to try again.`)}
        onHttpError={() => fail(`The ${subject} viewer could not load. Reconnect to try again.`)}
        onContentProcessDidTerminate={processTerminated}
        onRenderProcessGone={processTerminated}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:blank" || request.url === source.baseUrl
        }
        onMessage={(event) => {
          if (!active.current || failed.current) return;
          const message = deviceStreamMessage(event.nativeEvent.data);
          if (message?.type === "unauthorized") void onUnauthorized();
          else if (message?.type === "input") void onInputConnected(message.connected);
          else if (message?.type === "retry") onRetry();
          else if (message?.type === "status") {
            setStarted(true);
            if (message.status === "error") fail(message.detail ?? `The ${subject} stream failed.`);
            else {
              setStatus(message.status);
              if (message.status === "streaming") onStreaming();
            }
          }
        }}
      />
      {status !== "streaming" ? (
        <View
          className="absolute inset-0 items-center justify-center gap-4 px-6"
          style={{ backgroundColor: background }}
        >
          {status === "connecting" ? <AppActivityIndicator colorClassName="accent-icon" /> : null}
          <AppText
            accessibilityLiveRegion="polite"
            className="text-center text-sm text-foreground-muted"
          >
            {status === "error" ? error : `Connecting to ${subject}...`}
          </AppText>
          {status === "error" ? (
            <Pressable
              accessibilityRole="button"
              className="rounded-full border border-secondary-border bg-secondary px-6 py-3"
              onPress={onRetry}
            >
              <AppText className="text-secondary-foreground">Reconnect</AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
