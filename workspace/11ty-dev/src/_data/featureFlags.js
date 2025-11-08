const gatewayEndpoint = process.env.HFY_FEATURE_FLAGS__GATEWAY__ENDPOINT || "/api/check-allowed";
const gatewayContext = process.env.HFY_FEATURE_FLAGS__GATEWAY__CONTEXT || "site";
const runtimeEnv = process.env.HFY_ENV || process.env.NODE_ENV || "dev";
const hasExplicitEnforceFlag = Object.prototype.hasOwnProperty.call(
  process.env,
  "HFY_FEATURE_FLAGS__GATEWAY__ENFORCE_ASSETS"
);
const gatewayEnforceAssets = hasExplicitEnforceFlag
  ? process.env.HFY_FEATURE_FLAGS__GATEWAY__ENFORCE_ASSETS === "true"
  : runtimeEnv === "prod";
const flagsDebug = process.env.HFY_FEATURE_FLAGS__DEBUG === "true";

module.exports = () => ({
  defaultState: {
    loggedIn: false,
    sessionToken: null,
    userGrampsID: null,
    hasRecord: false
  },
  gateway: {
    endpoint: gatewayEndpoint,
    context: gatewayContext,
    enforceAssets: gatewayEnforceAssets,
    debug: flagsDebug
  },
  components: {
    navbarSearch: {
      description: "Global navigation search experience (autocomplete + search results entry point).",
      showWhen: {
        loggedIn: [true, "true"]
      },
      assets: [
        {
          type: "json",
          path: "/person/index.json"
        },
        {
          type: "json",
          path: "/person/search-index.json"
        }
      ]
    },
    familyLoginLink: {
      description: "Primary navigation link routing to the family login experience.",
      showWhen: {
        loggedIn: [false, "false", "unknown", null]
      }
    },
    logoutLink: {
      description: "Navigation link that signs the user out of the site.",
      showWhen: {
        loggedIn: [true, "true"]
      }
    },
    myRecordLink: {
      description: "Personalized navigation link that points directly to the signed-in visitor's Gramps record.",
      showWhen: {
        loggedIn: [true, "true"],
        hasRecord: [true, "true"]
      }
    }
  }
});
