import { defineConfig } from 'staticforge';

export default defineConfig({
  site: {
    title: 'Basic Site',
    baseUrl: 'https://basic.example.com',
    language: 'en',
    description: 'An example staticforge site exercising every content type.',
    author: 'The staticforge authors',
  },
  styles: ['/assets/css/site.css'],
  scripts: ['/assets/js/site.js'],
});
