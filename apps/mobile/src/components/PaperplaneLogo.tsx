import Constants from "expo-constants";
import { Image } from "expo-image";

const appVariant = Constants.expoConfig?.extra?.appVariant;
const PAPERPLANE_LOGO_SOURCE =
  appVariant === "development"
    ? require("../../../../assets/dev/blueprint-ios-1024.png")
    : appVariant === "preview"
      ? require("../../../../assets/nightly/nightly-ios-1024.png")
      : require("../../../../assets/prod/black-ios-1024.png");

/** Compact Paperplane logo used in navigation-bar brand lockups. */
export function PaperplaneLogo(props: { readonly height: number }) {
  return (
    <Image
      accessibilityLabel="Paperplane"
      source={PAPERPLANE_LOGO_SOURCE}
      style={{
        borderRadius: props.height * 0.24,
        height: props.height,
        width: props.height,
      }}
    />
  );
}
