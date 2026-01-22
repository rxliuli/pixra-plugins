# Pixra Plugins

This repository hosts the plugin index for [Pixra](https://github.com/rxliuli/pixra), an open-source web image editor.

## How it works

1. A GitHub Action runs every 30 minutes to scan npm for packages with the keyword `pixra-plugin`
2. Found plugins are downloaded, validated, and archived to the `/plugins` directory
3. A `plugins.json` index file is generated for the Pixra app to consume

## For plugin developers

To publish your plugin:

1. Create a plugin using `@pixra/plugin-cli`
2. Add `"pixra-plugin"` to your `package.json` keywords
3. Publish to npm: `npm publish`

Your plugin will be automatically picked up within 30 minutes.

### Package structure

Your npm package should have the following structure after build:

```
dist/
  manifest.json   # Plugin manifest
  main.js         # Plugin entry point
README.md         # Optional, will be displayed in plugin store
```

### manifest.json

```json
{
  "id": "your-plugin-id",
  "name": "Your Plugin Name",
  "version": "1.0.0",
  "description": "What your plugin does",
  "main": "main.js"
}
```

## Plugin index

The `plugins.json` file contains metadata for all available plugins:

```json
{
  "updatedAt": "2026-01-22T12:00:00Z",
  "plugins": [
    {
      "id": "plugin-id",
      "name": "Plugin Name",
      "description": "...",
      "version": "1.0.0",
      "author": "...",
      "publisher": "npm-username",
      "official": false,
      "publishedAt": "2026-01-22T10:00:00Z",
      "size": 12345
    }
  ]
}
```

## License

AGPL-3.0
