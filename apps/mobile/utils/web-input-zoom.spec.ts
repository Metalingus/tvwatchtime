import {
  IOS_WEB_INPUT_MIN_FONT_SIZE,
  IOS_WEB_INPUT_ZOOM_CSS,
  IOS_WEB_INPUT_ZOOM_STYLE_ID,
  installIosWebInputZoomGuard,
} from './web-input-zoom';

describe('installIosWebInputZoomGuard', () => {
  it('installs one iOS touch-web style with a 16px minimum', () => {
    const appended: any[] = [];
    let installed: any = null;
    const doc = {
      getElementById: jest.fn(() => installed),
      createElement: jest.fn(() => ({ id: '', textContent: '' })),
      head: {
        appendChild: jest.fn((node) => {
          installed = node;
          appended.push(node);
        }),
      },
    } as unknown as Document;

    installIosWebInputZoomGuard(doc);
    installIosWebInputZoomGuard(doc);

    expect(IOS_WEB_INPUT_MIN_FONT_SIZE).toBe(16);
    expect(IOS_WEB_INPUT_ZOOM_CSS).toContain('input, textarea, select');
    expect(IOS_WEB_INPUT_ZOOM_CSS).toContain('font-size: 16px !important');
    expect(appended).toEqual([
      expect.objectContaining({
        id: IOS_WEB_INPUT_ZOOM_STYLE_ID,
        textContent: IOS_WEB_INPUT_ZOOM_CSS,
      }),
    ]);
  });
});
