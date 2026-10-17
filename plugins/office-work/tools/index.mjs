import {registerOfficialCLI} from './official-cli.mjs';
import {registerDocumentTools} from './document-tools.mjs';
export function registerTools(){return [registerOfficialCLI(),...registerDocumentTools()];}
