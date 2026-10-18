const { withEntitlementsPlist } = require("expo/config-plugins");

module.exports = function withoutIosPersonalTeamCapabilities(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    // Let the eventual signer supply its default group; a baked-in prefix or
    // bundle ID can invalidate free provisioning after a sideload tool rewrites it.
    delete modConfig.modResults["keychain-access-groups"];
    delete modConfig.modResults["aps-environment"];
    delete modConfig.modResults["com.apple.developer.applesignin"];
    delete modConfig.modResults["com.apple.security.application-groups"];
    return modConfig;
  });
};
