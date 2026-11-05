import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

/**
 * The desktop app loads exactly one CommonJS file for a plugin's GUI and cannot
 * fetch a second chunk, so the official preset does the bundling rules for us:
 * one file, every dynamic import inlined, Electron and node built-ins external,
 * and a hard failure if we reach for a module the app does not provide.
 *
 * Output path is what `./gui-experimental` in package.json points at.
 */
export default defineConfig({
  plugins: [gui()],
})
