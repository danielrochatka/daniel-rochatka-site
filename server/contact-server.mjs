import { createContactServer, validateEnv } from './contact-service.mjs';

const config = validateEnv(process.env);
const server = createContactServer({
  config,
  log: (entry) => console.log(JSON.stringify(entry)),
});

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), category: 'listening', host: config.host, port: config.port }));
});
