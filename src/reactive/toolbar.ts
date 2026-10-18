/**
 * The reactivity switch on the notebook toolbar.
 *
 * @module
 */
import { nullTranslator } from '@jupyterlab/translation';
import type { ITranslator } from '@jupyterlab/translation';
import { ToolbarButton, offlineBoltIcon } from '@jupyterlab/ui-components';
import type { ReactiveController } from './controller';

/**
 * Make the toggle button for a notebook's controller.
 *
 * @param controller - The notebook's controller; the button shows and sets its switch.
 * @param translator - The application translator.
 * @returns The button, to be placed by the toolbar factory.
 *
 * @remarks
 * Modelled on the debugger's bug button (`@jupyterlab/debugger/src/handler.ts:38-64`): a
 * `ToolbarButton` (`@jupyterlab/ui-components/src/components/toolbar.tsx:955`) with `pressed` for
 * the switch and `enabled` for the kernel's capability, and a tooltip for each state. Two things
 * about that class shape the code. Its `onClick` getter wraps the handler and flips `pressed`
 * before calling it (`toolbar.tsx:1021-1029`), so the handler sets the controller and then the
 * button is re-synced from the controller rather than trusted. And setting `pressed` is a no-op
 * while the button is disabled (`toolbar.tsx:972-977`), so `sync` sets `enabled` first, the order
 * the debugger's `updateIconButtonState` uses (`handler.ts:75-88`).
 */
export function createReactiveButton(controller: ReactiveController, translator?: ITranslator): ToolbarButton {
  const trans = (translator ?? nullTranslator).load('jupyter-dag');
  const button = new ToolbarButton({
    className: 'jp-ReactiveButton',
    icon: offlineBoltIcon,
    tooltip: trans.__('Enable reactive execution'),
    pressedTooltip: trans.__('Disable reactive execution'),
    disabledTooltip: trans.__('Select a kernel that supports cell analysis to enable reactive execution'),
    enabled: controller.available,
    pressed: controller.enabled,
    onClick: () => {
      controller.enabled = !controller.enabled;
      sync();
    }
  });
  const sync = (): void => {
    button.enabled = controller.available;
    button.pressed = controller.enabled;
  };
  controller.stateChanged.connect(sync);
  button.disposed.connect(() => controller.stateChanged.disconnect(sync));
  return button;
}
