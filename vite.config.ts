import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

export default defineConfig({
  base: '/compression-stand/',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
})