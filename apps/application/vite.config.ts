import { defineConfig } from 'vite';
export default defineConfig({publicDir:false,build:{outDir:'public',emptyOutDir:true}, server:{proxy:{'/api':'http://127.0.0.1:8082'}}});
