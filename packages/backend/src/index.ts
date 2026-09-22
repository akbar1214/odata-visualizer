import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createApp } from './app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env['PORT'] || 3001;
const app = createApp();

app.listen(PORT, () => {
  console.log(`🚀 OData Visualizer backend running on http://localhost:${PORT}`);
  console.log(`🔌 MCP server available at http://localhost:${PORT}/mcp`);

  const frontendDistPath = join(__dirname, '../../frontend/dist');
  if (existsSync(frontendDistPath)) {
    console.log(`📦 Frontend served from ${frontendDistPath}`);
  }
});

export default app;
