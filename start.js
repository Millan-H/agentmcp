import { configFromEnv, createApp } from './app-server.js';

const { HOST = '127.0.0.1', PORT = 3000 } = process.env;
const app = createApp(configFromEnv(process.env));
app.listen(Number(PORT), HOST, () => console.log(`Relayroom listening on http://${HOST}:${app.address().port}`));
