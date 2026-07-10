import { createDialogController } from '@tvwatch/shared';
import type { DialogController, DialogEntry } from '@tvwatch/shared';

type CtrlWithRunner = DialogController & {
  runButton: (entry: DialogEntry, index: number) => Promise<void>;
};

describe('dialog controller', () => {
  let ctrl: CtrlWithRunner;

  beforeEach(() => {
    ctrl = createDialogController() as CtrlWithRunner;
  });

  // Await a button press so async close-on-success is observable in assertions.
  const press = (entry: DialogEntry, index: number) => ctrl.runButton(entry, index);

  it('starts with an empty stack', () => {
    expect(ctrl.entries).toEqual([]);
  });

  it('showInfo opens a dialog with a single primary OK button', () => {
    const id = ctrl.showInfo({ description: 'hello' });
    expect(ctrl.entries).toHaveLength(1);
    const entry = ctrl.entries[0];
    expect(entry.id).toBe(id);
    expect(entry.title).toBe('Info');
    expect(entry.description).toBe('hello');
    expect(entry.dismissible).toBe(true);
    expect(entry.showCloseButton).toBe(true);
    expect(entry.buttons).toHaveLength(1);
    expect(entry.buttons[0]).toMatchObject({ label: 'OK', variant: 'primary', closeOnPress: true });
  });

  it('showSuccess and showError use default titles', () => {
    ctrl.showSuccess({ description: 'done' });
    expect(ctrl.entries[0].title).toBe('Success');
    ctrl.dismiss();
    ctrl.showError({ title: 'Oops', description: 'nope' });
    expect(ctrl.entries[0].title).toBe('Oops');
  });

  it('showConfirm produces cancel + confirm with destructive styling', () => {
    const onConfirm = jest.fn();
    ctrl.showConfirm({ title: 'Remove?', confirmLabel: 'Remove', destructive: true, onConfirm });
    const entry = ctrl.entries[0];
    expect(entry.buttons).toHaveLength(2);
    expect(entry.buttons[0]).toMatchObject({ label: 'Cancel', variant: 'secondary' });
    expect(entry.buttons[1]).toMatchObject({ label: 'Remove', variant: 'danger', closeOnPress: true });
  });

  it('showDialog supports multiple stacked buttons and custom variants', () => {
    ctrl.showDialog({
      title: 'Manage',
      buttons: [
        { label: 'Report', variant: 'secondary' },
        { label: 'Delete', variant: 'danger' },
        { label: 'Block', variant: 'primary' },
        { label: 'Cancel', variant: 'ghost' },
      ],
    });
    const entry = ctrl.entries[0];
    expect(entry.buttons.map((b) => b.label)).toEqual(['Report', 'Delete', 'Block', 'Cancel']);
    expect(entry.buttons.map((b) => b.variant)).toEqual(['secondary', 'danger', 'primary', 'ghost']);
  });

  it('respects dismissible=false (hides close button)', () => {
    ctrl.showDialog({ title: 'x', dismissible: false, buttons: [{ label: 'OK' }] });
    const entry = ctrl.entries[0];
    expect(entry.dismissible).toBe(false);
    expect(entry.showCloseButton).toBe(false);
  });

  it('showCloseButton defaults to dismissible but can be overridden', () => {
    ctrl.showDialog({ title: 'x', dismissible: true, showCloseButton: false, buttons: [{ label: 'OK' }] });
    expect(ctrl.entries[0].showCloseButton).toBe(false);
  });

  it('maintains a LIFO stack and dismisses top when no id given', () => {
    const a = ctrl.showInfo({ description: 'a' });
    const b = ctrl.showInfo({ description: 'b' });
    expect(ctrl.entries.map((e) => e.id)).toEqual([a, b]);
    ctrl.dismiss();
    expect(ctrl.entries.map((e) => e.id)).toEqual([a]);
    ctrl.dismiss(b); // id no longer in stack -> no-op
    expect(ctrl.entries).toHaveLength(1);
  });

  it('dismissAll clears the stack', () => {
    ctrl.showInfo({ description: 'a' });
    ctrl.showInfo({ description: 'b' });
    ctrl.dismissAll();
    expect(ctrl.entries).toEqual([]);
  });

  it('notifies subscribers on changes', () => {
    const listener = jest.fn();
    const unsub = ctrl.subscribe(listener);
    ctrl.showInfo({ description: 'x' });
    expect(listener).toHaveBeenCalled();
    unsub();
    listener.mockClear();
    ctrl.showInfo({ description: 'y' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('runs a synchronous onPress and closes on success', async () => {
    const onPress = jest.fn();
    const id = ctrl.showDialog({ title: 'x', buttons: [{ label: 'Go', onPress }] });
    await press(ctrl.entries.find((e) => e.id === id)!, 0);
    expect(onPress).toHaveBeenCalled();
    expect(ctrl.entries.find((e) => e.id === id)).toBeUndefined();
  });

  it('stays open when an async onPress rejects', async () => {
    const onPress = jest.fn().mockRejectedValueOnce(new Error('boom'));
    const id = ctrl.showDialog({ title: 'x', buttons: [{ label: 'Go', onPress }] });
    await press(ctrl.entries.find((e) => e.id === id)!, 0);
    expect(ctrl.entries.find((e) => e.id === id)).toBeDefined();
    expect(onPress).toHaveBeenCalled();
  });

  it('does not close when closeOnPress is false', async () => {
    const onPress = jest.fn();
    const id = ctrl.showDialog({ title: 'x', buttons: [{ label: 'Go', onPress, closeOnPress: false }] });
    await press(ctrl.entries.find((e) => e.id === id)!, 0);
    expect(onPress).toHaveBeenCalled();
    expect(ctrl.entries.find((e) => e.id === id)).toBeDefined();
  });

  it('treats a button with no onPress as a plain close', async () => {
    const id = ctrl.showDialog({ title: 'x', buttons: [{ label: 'OK' }] });
    await press(ctrl.entries.find((e) => e.id === id)!, 0);
    expect(ctrl.entries.find((e) => e.id === id)).toBeUndefined();
  });

  it('sets loading while an async onPress is pending and prevents double-submit', async () => {
    let resolveAction: () => void = () => {};
    const onPress = jest.fn(
      () => new Promise<void>((resolve) => {
        resolveAction = resolve;
      }),
    );
    const id = ctrl.showDialog({ title: 'x', buttons: [{ label: 'Go', onPress }] });
    const entry = ctrl.entries.find((e) => e.id === id)!;
    const p = press(entry, 0);
    // While pending, the button shows loading and is locked.
    expect(ctrl.entries.find((e) => e.id === id)!.buttons[0].loading).toBe(true);
    await press(entry, 0); // second press while busy -> no double invocation
    expect(onPress).toHaveBeenCalledTimes(1);
    resolveAction();
    await p;
    expect(ctrl.entries.find((e) => e.id === id)).toBeUndefined();
  });

  it('default helper buttons are added when an empty buttons array is supplied', () => {
    ctrl.showDialog({ title: 'x', buttons: [] });
    expect(ctrl.entries[0].buttons).toHaveLength(1);
    expect(ctrl.entries[0].buttons[0].label).toBe('OK');
  });
});
