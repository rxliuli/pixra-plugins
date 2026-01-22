import fs from 'fs/promises'
import path from 'path'
import { gunzipSync } from 'zlib'
import JSZip from 'jszip'

const SEARCH_KEYWORD = 'pixra-plugin'
const PLUGINS_DIR = 'plugins'
const PLUGINS_JSON = 'plugins.json'

interface NpmSearchResult {
  objects: Array<{
    package: {
      name: string
      version: string
      description?: string
      keywords?: string[]
      author?: { name: string } | string
      repository?: { url: string } | string
      homepage?: string
      license?: string
      publisher?: { username: string }
      date: string
    }
  }>
  total: number
}

interface NpmPackageManifest {
  dist: {
    tarball: string
    fileCount?: number
    unpackedSize?: number
  }
}

interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  main: string
  minAppVersion?: string
  permissions?: string[]
  host_permissions?: string[]
  contributes?: {
    commands?: Array<{
      command: string
      title: string
    }>
    menus?: Record<string, Array<{ command: string }>>
  }
}

interface PluginInfo {
  id: string
  name: string
  description: string
  version: string
  minAppVersion?: string
  author: string
  repository?: string
  homepage?: string
  license?: string
  publisher: string
  official: boolean
  publishedAt: string
  size: number
}

interface PluginsJson {
  updatedAt: string
  plugins: PluginInfo[]
}

async function searchNpmPackages(): Promise<NpmSearchResult> {
  const url = `https://registry.npmjs.org/-/v1/search?text=keywords:${SEARCH_KEYWORD}&size=250`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to search npm: ${response.status}`)
  }
  return response.json()
}

async function getPackageManifest(
  name: string,
  version: string,
): Promise<NpmPackageManifest> {
  const url = `https://registry.npmjs.org/${name}/${version}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to get package manifest: ${response.status}`)
  }
  return response.json()
}

async function downloadAndExtractTarball(
  tarballUrl: string,
): Promise<Map<string, Buffer>> {
  const response = await fetch(tarballUrl)
  if (!response.ok) {
    throw new Error(`Failed to download tarball: ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // npm tarballs are gzipped
  const decompressed = gunzipSync(buffer)

  // Parse tar archive
  const files = new Map<string, Buffer>()
  let offset = 0

  while (offset < decompressed.length) {
    // Read header (512 bytes)
    const header = decompressed.slice(offset, offset + 512)

    // Check for end of archive (two consecutive zero blocks)
    if (header.every((b) => b === 0)) {
      break
    }

    // Parse filename (first 100 bytes, null-terminated)
    let filename = header.slice(0, 100).toString('utf8').replace(/\0/g, '')

    // Remove 'package/' prefix that npm adds
    if (filename.startsWith('package/')) {
      filename = filename.slice(8)
    }

    // Parse file size (bytes 124-135, octal)
    const sizeStr = header.slice(124, 136).toString('utf8').trim()
    const size = parseInt(sizeStr, 8) || 0

    // Parse type flag (byte 156)
    const typeFlag = header[156]

    offset += 512 // Move past header

    // Only process regular files (type '0' or '\0')
    if ((typeFlag === 48 || typeFlag === 0) && size > 0) {
      const content = decompressed.slice(offset, offset + size)
      files.set(filename, content)
    }

    // Move to next entry (size rounded up to 512 bytes)
    offset += Math.ceil(size / 512) * 512
  }

  return files
}

function validateManifest(manifest: unknown): manifest is PluginManifest {
  if (typeof manifest !== 'object' || manifest === null) return false
  const m = manifest as Record<string, unknown>
  return (
    typeof m.id === 'string' &&
    typeof m.name === 'string' &&
    typeof m.version === 'string' &&
    typeof m.main === 'string'
  )
}

async function processPackage(
  pkg: NpmSearchResult['objects'][0]['package'],
): Promise<PluginInfo | null> {
  console.log(`Processing ${pkg.name}@${pkg.version}...`)

  try {
    // Get package manifest from npm registry
    const npmManifest = await getPackageManifest(pkg.name, pkg.version)

    // Download and extract tarball
    const files = await downloadAndExtractTarball(npmManifest.dist.tarball)

    // Find plugin.json in dist/
    const manifestContent = files.get('dist/plugin.json')
    if (!manifestContent) {
      console.warn(`  No dist/plugin.json found in ${pkg.name}`)
      return null
    }

    const manifest: unknown = JSON.parse(manifestContent.toString('utf8'))
    if (!validateManifest(manifest)) {
      console.warn(`  Invalid manifest in ${pkg.name}`)
      return null
    }

    // Find main.js in dist/
    const mainJs = files.get(`dist/${manifest.main}`)
    if (!mainJs) {
      console.warn(`  No dist/${manifest.main} found in ${pkg.name}`)
      return null
    }

    // Create plugin.zip containing plugin.json and plugin.js
    const zip = new JSZip()
    zip.file('plugin.json', manifestContent)
    zip.file(manifest.main, mainJs)

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    })

    // Create plugin directory
    const pluginDir = path.join(PLUGINS_DIR, manifest.id)
    await fs.mkdir(pluginDir, { recursive: true })

    // Write files
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), manifestContent)
    await fs.writeFile(path.join(pluginDir, 'plugin.zip'), zipBuffer)

    // Try to get README
    const readme =
      files.get('README.md') || files.get('readme.md') || files.get('Readme.md')
    if (readme) {
      await fs.writeFile(path.join(pluginDir, 'README.md'), readme)
    }

    // Extract author info
    let author = 'Unknown'
    if (typeof pkg.author === 'string') {
      author = pkg.author
    } else if (pkg.author?.name) {
      author = pkg.author.name
    }

    // Extract repository URL
    let repository: string | undefined
    if (typeof pkg.repository === 'string') {
      repository = pkg.repository
    } else if (pkg.repository?.url) {
      repository = pkg.repository.url
        .replace(/^git\+/, '')
        .replace(/\.git$/, '')
    }

    // Determine if official (under @pixra scope or @pixra-plugins scope)
    const isOfficial =
      pkg.name.startsWith('@pixra/') || pkg.name.startsWith('@pixra-plugins/')

    const pluginInfo: PluginInfo = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description || pkg.description || '',
      version: manifest.version,
      minAppVersion: manifest.minAppVersion,
      author,
      repository,
      homepage: pkg.homepage,
      license: pkg.license,
      publisher: pkg.publisher?.username || author,
      official: isOfficial,
      publishedAt: pkg.date,
      size: zipBuffer.length,
    }

    console.log(`  ✓ ${manifest.id}@${manifest.version}`)
    return pluginInfo
  } catch (error) {
    console.error(`  ✗ Failed to process ${pkg.name}:`, error)
    return null
  }
}

async function loadExistingPlugins(): Promise<PluginsJson | null> {
  try {
    const content = await fs.readFile(PLUGINS_JSON, 'utf8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

async function main() {
  console.log('Scanning npm for pixra plugins...\n')

  // Search npm
  const searchResult = await searchNpmPackages()
  console.log(
    `Found ${searchResult.total} packages with keyword "${SEARCH_KEYWORD}"\n`,
  )

  if (searchResult.objects.length === 0) {
    console.log('No plugins found.')
    return
  }

  // Load existing plugins.json for comparison
  const existing = await loadExistingPlugins()
  const existingMap = new Map(
    existing?.plugins.map((p) => [`${p.id}@${p.version}`, p]) || [],
  )

  // Ensure plugins directory exists
  await fs.mkdir(PLUGINS_DIR, { recursive: true })

  // Process each package
  const plugins: PluginInfo[] = []
  for (const { package: pkg } of searchResult.objects) {
    // Check if we already have this exact version
    const existingPlugin = existingMap.get(`${pkg.name}@${pkg.version}`)
    if (existingPlugin) {
      console.log(`Skipping ${pkg.name}@${pkg.version} (already processed)`)
      plugins.push(existingPlugin)
      continue
    }

    const pluginInfo = await processPackage(pkg)
    if (pluginInfo) {
      plugins.push(pluginInfo)
    }
  }

  // Sort by publishedAt descending
  plugins.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  )

  // Write plugins.json
  const pluginsJson: PluginsJson = {
    updatedAt: new Date().toISOString(),
    plugins,
  }

  await fs.writeFile(PLUGINS_JSON, JSON.stringify(pluginsJson, null, 2))
  console.log(`\nWrote ${PLUGINS_JSON} with ${plugins.length} plugins`)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
