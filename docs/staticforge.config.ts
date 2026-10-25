import { defineConfig } from 'staticforge';

// The staticforge documentation, built with staticforge. Hosting comes with M9;
// until then baseUrl is a placeholder.
export default defineConfig({
  site: {
    title: 'staticforge',
    description: 'Build, check, preview and deploy accessible static sites from the command line.',
    baseUrl: 'https://staticforge.example.com',
    author: 'Eleftherios Chaniotakis',
  },
  // The docs must be clean: warnings fail the check too.
  check: { failOn: 'warning' },
});
