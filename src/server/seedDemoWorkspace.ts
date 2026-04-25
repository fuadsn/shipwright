import { ensureDemoWorkspace } from "./demoWorkspace";

ensureDemoWorkspace(true)
  .then((repo) => {
    console.log(`Seeded demo workspace at ${repo}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
