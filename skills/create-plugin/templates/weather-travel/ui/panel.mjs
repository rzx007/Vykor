import { App, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { config, names, planUri } from '../src/identity.mjs';
import { createPanel } from './view.mjs';

const app = new App({ name: config.displayName, version: config.version }, { availableDisplayModes: ['fullscreen'] });
const panel = createPanel({ app, document, names, config, applyStyle: applyHostStyleVariables });
// Register before connect: the host may deliver its first result during initialization.
app.ontoolresult = result => panel.receive(result);
app.onhostcontextchanged = context => panel.hostContext(context);
app.setNotificationHandler(ResourceListChangedNotificationSchema, () => panel.resourceChanged());
app.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => { if (notification.params.uri === planUri) panel.resourceChanged(); });
app.onteardown = async () => { panel.dispose(); return {}; };
app.connect().then(() => panel.start()).catch(error => { document.getElementById('status').textContent = error.message || '无法连接应用，请重新打开。'; });
