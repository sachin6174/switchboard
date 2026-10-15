import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [{
    name: "production-csp",
    transformIndexHtml(html, context) {
      if (context.server) return html;
      const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' http://localhost:3005 http://127.0.0.1:3005; object-src 'none'; base-uri 'none'; frame-src 'none'";
      return html.replace("</head>", `<meta http-equiv="Content-Security-Policy" content="${policy}" /></head>`);
    },
  }],
  build: { outDir: "dist/renderer", emptyOutDir: true },
});
