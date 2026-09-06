// Keep the original download command as an alias for the cross-platform updater.
import { main } from "../agent-app/update-agent-app.mjs";

await main(process.argv.slice(2));
