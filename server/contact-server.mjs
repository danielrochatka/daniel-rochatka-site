import { createContactServer, validateEnv } from './contact-service.mjs';
import { initStore, createNullStore } from './contact-store.mjs';

const config = validateEnv(process.env);

const store = config.dataDir
  ? await initStore(config.dataDir)
  : createNullStore();

const server = createContactServer({
  config,
  store,
  log: (entry) => console.log(JSON.stringify(entry)),
});

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), category: 'listening', host: config.host, port: config.port }));
});
