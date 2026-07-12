/**
 * Local ESLint rule: flags hardcoded color literals in Expo mobile source.
 *
 * Detects:
 *   - hex colors (#rgb / #rrggbb / #rrggbbaa) — anywhere in a string literal
 *   - rgb()/rgba()/hsl()/hsla() function strings — anywhere in a string literal
 *   - CSS named colors (white, black, red, …) — only when used as the value of a
 *     known color/style property (avoids flagging prose)
 *
 * Rationale: the app resolves all UI color from `useAppearance().tokens`. Hardcoded
 * colors break light/dark theming. Allowed exceptions: `transparent`, the static
 * design-token palette file (ignored via config), and inline `eslint-disable` comments.
 *
 * Suppress with:  // eslint-disable-next-line no-hardcoded-colors
 */
'use strict';

/** @type {Set<string>} */
const NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque',
  'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue',
  'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan',
  'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgrey', 'darkgreen',
  'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred',
  'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey',
  'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey',
  'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro',
  'ghostwhite', 'gold', 'goldenrod', 'gray', 'grey', 'green', 'greenyellow',
  'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral',
  'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgrey', 'lightgreen',
  'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray',
  'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen',
  'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid',
  'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen',
  'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose',
  'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise',
  'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum',
  'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue',
  'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver',
  'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat',
  'white', 'whitesmoke', 'yellow', 'yellowgreen',
]);

/** @type {Set<string>} */
const ALLOWED_LITERALS = new Set(['transparent']);

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FUNC_RE = /\b(?:rgb|rgba|hsl|hsla)\s*\(/i;

/** Property / attribute names whose string value is a color. */
const COLOR_PROP_RE =
  /^(color|backgroundColor|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|shadowColor|textShadowColor|tintColor|placeholderTextColor|selectionColor|cursorColor|underlineColorAndroid|trackColor|thumbColor|progressBackgroundColor|stroke|fill|stopColor|floodColor|lightingColor|strokeWidth)$/i;

/**
 * Walk up the parent chain to see if this literal lives in a color-style context.
 * Catches direct property values, JSX attribute values, ternaries, and array
 * elements (gradient `colors=[...]`).
 * @param {any} node
 * @returns {boolean}
 */
function isInColorContext(node) {
  let current = node.parent;
  let depth = 0;
  while (current && depth < 5) {
    if (current.type === 'Property') {
      const keyName =
        current.key && (current.key.name || (typeof current.key.value === 'string' ? current.key.value : null));
      if (keyName && COLOR_PROP_RE.test(keyName)) return true;
      // Array value of a `colors`/`gradient` style prop (e.g. LinearGradient colors=[...]).
      if (keyName && /^(colors|gradient|mediaGradient)$/i.test(keyName)) return true;
    }
    if (current.type === 'JSXAttribute') {
      const attrName = current.name && current.name.name;
      if (attrName && COLOR_PROP_RE.test(attrName)) return true;
    }
    if (current.type === 'JSXExpressionContainer') {
      // parent JSX attribute handled above when we reach it; keep walking.
    }
    current = current.parent;
    depth += 1;
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow hardcoded color literals; use useAppearance().tokens instead.',
    },
    schema: [],
    messages: {
      color:
        'Hardcoded color "{{value}}" — use a semantic token via useAppearance().tokens' +
        ' (or add a documented allowlist exception / eslint-disable).',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const value = node.value;
        const lower = value.toLowerCase();

        // Always allowed.
        if (ALLOWED_LITERALS.has(lower)) return;

        const isHex = HEX_RE.test(value);
        const isFunc = COLOR_FUNC_RE.test(value);
        const isNamed = NAMED_COLORS.has(lower.trim());

        // Hex / rgb()/hsl() are treated as color literals anywhere they appear
        // (in this app a `#…` or `rgb(` string is always a color, never prose).
        if (isHex || isFunc) {
          context.report({ node, messageId: 'color', data: { value } });
          return;
        }

        // Named colors are only flagged in a color-style context to avoid prose.
        if (isNamed && isInColorContext(node)) {
          context.report({ node, messageId: 'color', data: { value } });
        }
      },
    };
  },
};
