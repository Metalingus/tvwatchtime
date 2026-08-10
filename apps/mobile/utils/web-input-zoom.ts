import { typography } from '../theme/theme';

export const IOS_WEB_INPUT_ZOOM_STYLE_ID = 'tvwatch-ios-input-zoom-guard';
export const IOS_WEB_INPUT_MIN_FONT_SIZE = Math.max(16, typography.body.fontSize);
export const IOS_WEB_INPUT_ZOOM_CSS = `
@supports (-webkit-touch-callout: none) {
  @media (hover: none) and (pointer: coarse) {
    input, textarea, select {
      font-size: ${IOS_WEB_INPUT_MIN_FONT_SIZE}px !important;
    }
  }
}
`;

/** Prevent iOS WebKit from zooming the page when a form control receives focus. */
export function installIosWebInputZoomGuard(doc?: Document): void {
  if (!doc || doc.getElementById(IOS_WEB_INPUT_ZOOM_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = IOS_WEB_INPUT_ZOOM_STYLE_ID;
  style.textContent = IOS_WEB_INPUT_ZOOM_CSS;
  doc.head.appendChild(style);
}
