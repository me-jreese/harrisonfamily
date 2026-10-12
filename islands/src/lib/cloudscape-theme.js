// Cloudscape's half of the harrisonfamily search theme (interim HFY override), as data. islands/build.mjs turns it into CSS at build
// time (`@import "hfy:cloudscape-theme"` in src/islands/search.css) with Cloudscape's own generateThemeStylesheet, so the island ships
// a static stylesheet instead of the theming runtime and its token preset (about 100 KB gzipped) and nothing is injected at runtime.
//
// Kit root cause: @io-kit/search-ui 1.0.10's theme emitter knows only SEARCH_APPS = [enceladus, think, vagamod]; with no
// harrisonfamily app the island never gets a Cloudscape theme, so the parts that are Cloudscape's (the row-1 input and the Sort trigger
// from 688, the suggestion and sort dropdowns, the PropertyFilter in the Filter sheet) drew its stock dark theme: navy fields and
// popovers, 14px Open Sans, 32px rows, a 1px blue focus ring. Upstream (kit backlog): add harrisonfamily to SEARCH_APPS /
// resolveSearchTheme from the @io-kit/tokens 0.4.0 harrisonfamily theme and ship themes/harrisonfamily.css with its Cloudscape half;
// then delete this module, the build plugin and the search.css import.
//
// Every value is a var() of the --io-search-* contract (kit-bridge), so no literal reaches app code and the tokens stay the source.
// Colours are { dark } values: the island is dark-only (useColorMode("dark")), and a light value equal to the dark one is collapsed
// by the generator into the root block only. @cloudscape-design/components is search-ui's exact-pinned dependency (3.0.1396).
const cs = (name) => `var(--io-search-${name})`;
const dark = (name) => ({ dark: cs(name) });
const bodyLine = `calc(${cs("font-size-sm")} * var(--io-typography-leading-normal))`;
export const CLOUDSCAPE_TOKENS = {
  fontFamilyBase: cs("font-ui"),
  fontFamilyHeading: cs("font-ui"),
  fontFamilyDisplay: cs("font-display"),
  fontFamilyMonospace: cs("font-mono"),
  // the 16px floor for every Cloudscape string (body-m was 14, body-s 12)
  fontSizeBodyM: cs("font-size-sm"),
  fontSizeBodyS: cs("font-size-sm"),
  lineHeightBodyM: bodyLine,
  lineHeightBodyS: bodyLine,
  sizeVerticalInput: cs("control-h"),
  borderRadiusInput: cs("radius-md"),
  borderRadiusButton: cs("radius-md"),
  borderRadiusDropdown: cs("radius-md"),
  borderRadiusPopover: cs("radius-md"),
  borderRadiusItem: cs("radius-sm"),
  borderRadiusToken: cs("radius-pill"),
  colorBackgroundPopover: dark("surface-raised"),
  colorBackgroundContainerContent: dark("surface-raised"),
  colorBackgroundDropdownItemDefault: dark("surface-raised"),
  colorBackgroundDropdownItemHover: dark("surface-sunken"),
  colorBackgroundDropdownItemSelected: dark("token-pill-bg"),
  colorBackgroundDropdownItemFilterMatch: dark("token-pill-bg"),
  colorBackgroundItemSelected: dark("token-pill-bg"),
  colorBackgroundInputDefault: dark("surface-sunken"),
  colorBackgroundInputDisabled: dark("surface-raised"),
  colorBackgroundButtonNormalDefault: dark("surface-raised"),
  colorBackgroundButtonNormalHover: dark("surface-sunken"),
  colorBackgroundButtonNormalActive: dark("surface-sunken"),
  colorBackgroundButtonPrimaryDefault: dark("accent"),
  colorBackgroundButtonPrimaryHover: dark("accent"),
  colorBackgroundButtonPrimaryActive: dark("accent"),
  colorBackgroundControlChecked: dark("accent"),
  colorForegroundControlDefault: dark("accent-text"),
  colorBorderDropdownContainer: dark("border-strong"),
  colorBorderDropdownItemHover: dark("border-strong"),
  colorBorderDropdownItemFocused: dark("focus"),
  colorBorderItemFocused: dark("focus"),
  colorBorderItemSelected: dark("accent"),
  colorBorderPopover: dark("border-strong"),
  colorBorderInputDefault: dark("border"),
  colorBorderInputFocused: dark("focus"),
  colorBorderControlDefault: dark("border-strong"),
  colorBorderDividerDefault: dark("border"),
  colorBorderButtonNormalDefault: dark("border-strong"),
  colorBorderButtonNormalHover: dark("link-hover"),
  colorTextBodyDefault: dark("text"),
  colorTextBodySecondary: dark("text-dim"),
  colorTextFormDefault: dark("text"),
  colorTextFormLabel: dark("text"),
  colorTextLabel: dark("text"),
  colorTextGroupLabel: dark("text-dim"),
  colorTextInputPlaceholder: dark("text-dim"),
  colorTextDropdownItemDefault: dark("text"),
  colorTextDropdownItemHighlighted: dark("text"),
  colorTextDropdownItemSecondary: dark("text-dim"),
  colorTextDropdownItemFilterMatch: dark("link"),
  colorTextLinkDefault: dark("link"),
  colorTextLinkHover: dark("link-hover"),
  colorTextAccent: dark("link"),
  colorTextInteractiveDefault: dark("link"),
  colorTextInteractiveHover: dark("link-hover"),
  colorTextInteractiveActive: dark("link"),
  colorTextButtonNormalDefault: dark("text"),
  colorTextButtonNormalHover: dark("link-hover"),
  colorTextButtonNormalActive: dark("text"),
  colorTextButtonPrimaryDefault: dark("accent-text"),
  colorTextButtonPrimaryHover: dark("accent-text"),
  colorTextButtonPrimaryActive: dark("accent-text"),
  colorTextStatusError: dark("danger"),
};
