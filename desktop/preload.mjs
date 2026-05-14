import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('autoBrowserDesktop', {
  version: '0.1.0',
});
