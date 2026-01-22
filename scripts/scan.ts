import fs from 'fs/promises'
import path from 'path'
import { execSync } from 'child_process'
import JSZip from 'jszip'

const SEARCH_KEYWORD = 'pixra-plugin'
const PLUGINS_DIR = 'plugins'
const PLUGINS_JSON = 'plugins.json'
const PACKAGE_JSON = 'package.json'

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

interface PackageJson {
  name: string
  version: string
  dependencies: Record<string, string>
  [key: string]: unknown
}

async function searchNpmPackages(): Promise<NpmSearchResult> {
  const url = `https://registry.npmjs.org/-/v1/search?text=keywords:${SEARCH_KEYWORD}&size=250`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to search npm: ${response.status}`)
  }
  return response.json()
}

async function readPackageJson(): Promise<PackageJson> {
  const content = await fs.readFile(PACKAGE_JSON, 'utf8')
  return JSON.parse(content)
}

async function writePackageJson(pkg: PackageJson): Promise<void> {
  await fs.writeFile(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + '\n')
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

async function processInstalledPackage(
  pkgName: string,
  searchInfo: NpmSearchResult['objects'][0]['package'] | null,
): Promise<PluginInfo | null> {
  const pkgPath = path.join('node_modules', pkgName)

  try {
    // Read package.json from node_modules
    const npmPkgJson = JSON.parse(
      await fs.readFile(path.join(pkgPath, 'package.json'), 'utf8'),
    )

    // Find plugin.json in dist/
    const manifestPath = path.join(pkgPath, 'dist', 'plugin.json')
    const manifestContent = await fs.readFile(manifestPath, 'utf8')
    const manifest: unknown = JSON.parse(manifestContent)

    if (!validateManifest(manifest)) {
      console.warn(`  Invalid manifest in ${pkgName}`)
      return null
    }

    // Find main.js in dist/
    const mainJsPath = path.join(pkgPath, 'dist', manifest.main)
    const mainJs = await fs.readFile(mainJsPath)

    // Create plugin.zip
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
    for (const readmeName of ['README.md', 'readme.md', 'Readme.md']) {
      try {
        const readme = await fs.readFile(path.join(pkgPath, readmeName))
        await fs.writeFile(path.join(pluginDir, 'README.md'), readme)
        break
      } catch {
        // Continue to next
      }
    }

    // Extract author info
    let author = 'Unknown'
    if (typeof npmPkgJson.author === 'string') {
      author = npmPkgJson.author
    } else if (npmPkgJson.author?.name) {
      author = npmPkgJson.author.name
    }

    // Extract repository URL
    let repository: string | undefined
    if (typeof npmPkgJson.repository === 'string') {
      repository = npmPkgJson.repository
    } else if (npmPkgJson.repository?.url) {
      repository = npmPkgJson.repository.url
        .replace(/^git\+/, '')
        .replace(/\.git$/, '')
    }

    // Determine if official
    const isOfficial =
      pkgName.startsWith('@pixra/') || pkgName.startsWith('@pixra-plugins/')

    // Get publishedAt from search info or use current time
    const publishedAt = searchInfo?.date || new Date().toISOString()

    const pluginInfo: PluginInfo = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description || npmPkgJson.description || '',
      version: manifest.version,
      minAppVersion: manifest.minAppVersion,
      author,
      repository,
      homepage: npmPkgJson.homepage,
      license: npmPkgJson.license,
      publisher: searchInfo?.publisher?.username || author,
      official: isOfficial,
      publishedAt,
      size: zipBuffer.length,
    }

    console.log(`  ✓ ${manifest.id}@${manifest.version}`)
    return pluginInfo
  } catch (error) {
    console.error(`  ✗ Failed to process ${pkgName}:`, error)
    return null
  }
}

async function main() {
  console.log('Scanning npm for pixra plugins...\n')

  // Step 1: Search npm to discover new packages
  const searchResult = await searchNpmPackages()
  console.log(
    `Found ${searchResult.total} packages with keyword "${SEARCH_KEYWORD}"\n`,
  )

  // Build a map of search results for metadata
  const searchMap = new Map(
    searchResult.objects.map((obj) => [obj.package.name, obj.package]),
  )

  // Step 2: Read current package.json and update dependencies
  const pkg = await readPackageJson()
  const existingDeps = new Set(Object.keys(pkg.dependencies || {}))
  let depsChanged = false

  for (const { package: npmPkg } of searchResult.objects) {
    if (!existingDeps.has(npmPkg.name)) {
      console.log(`Adding new dependency: ${npmPkg.name}`)
      pkg.dependencies = pkg.dependencies || {}
      pkg.dependencies[npmPkg.name] = 'latest'
      depsChanged = true
    }
  }

  // Step 3: Write updated package.json and run pnpm install
  // Use --no-frozen-lockfile for CI environments where lockfile may be outdated
  if (depsChanged) {
    await writePackageJson(pkg)
    console.log('\nRunning pnpm install to fetch packages...')
    execSync('pnpm install --no-frozen-lockfile', { stdio: 'inherit' })
    console.log()
  } else {
    console.log('No new packages to add.\n')
    // Still run update to ensure we have latest versions
    console.log('Running pnpm update to check for updates...')
    execSync('pnpm update --no-frozen-lockfile', { stdio: 'inherit' })
    console.log()
  }

  // Step 4: Process all installed packages
  await fs.mkdir(PLUGINS_DIR, { recursive: true })

  const plugins: PluginInfo[] = []
  const deps = Object.keys(pkg.dependencies || {})

  console.log(`Processing ${deps.length} packages...\n`)

  for (const depName of deps) {
    console.log(`Processing ${depName}...`)
    const searchInfo = searchMap.get(depName) || null
    const pluginInfo = await processInstalledPackage(depName, searchInfo)
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
