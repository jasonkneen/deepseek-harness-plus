const publishUrl = process.env.DSH_DESKTOP_SHELL_UPDATE_URL

export default {
  appId: 'com.deepseek.dsh',
  productName: 'DeepSeek Harness',
  artifactName: 'deepseek-harness-${version}-${os}-${arch}.${ext}',
  directories: { output: '.desktop-build/artifacts' },
  asar: true,
  files: [
    'lib/*.js',
    'lib/*.cjs',
    'renderer/**/*',
    'package.json',
  ],
  extraResources: [
    { from: '.desktop-build/runtime', to: 'runtime' },
    { from: '.desktop-build/seed', to: 'seed' },
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    target: ['dmg', 'zip'],
  },
  win: {
    target: ['nsis'],
  },
  linux: {
    category: 'Development',
    target: ['AppImage'],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    differentialPackage: true,
  },
  publish: publishUrl === undefined || publishUrl === ''
    ? null
    : [{ provider: 'generic', url: publishUrl }],
}
