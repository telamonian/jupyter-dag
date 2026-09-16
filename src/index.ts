import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { requestAPI } from './request';

/**
 * Initialization data for the @telamonian/jupyter-dag extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: '@telamonian/jupyter-dag:plugin',
  description: 'Organize notebook cells into DAGs and run them reactively in JupyterLab',
  autoStart: true,
  optional: [ISettingRegistry],
  activate: (app: JupyterFrontEnd, settingRegistry: ISettingRegistry | null) => {
    console.log('JupyterLab extension @telamonian/jupyter-dag is activated!');

    if (settingRegistry) {
      settingRegistry
        .load(plugin.id)
        .then(settings => {
          console.log('@telamonian/jupyter-dag settings loaded:', settings.composite);
        })
        .catch(reason => {
          console.error('Failed to load settings for @telamonian/jupyter-dag.', reason);
        });
    }

    requestAPI<any>('hello', app.serviceManager.serverSettings)
      .then(data => {
        console.log(data);
      })
      .catch(reason => {
        console.error(
          `The jupyter_dag server extension appears to be missing.\n${reason}`
        );
      });
  }
};

export default plugin;
