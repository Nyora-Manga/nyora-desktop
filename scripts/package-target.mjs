export function packageTarget(args, host = { platform: process.platform, arch: process.arch }) {
  const platforms = ['--mac', '--win', '--linux'].filter((flag) => args.includes(flag));
  const architectures = ['--x64', '--arm64'].filter((flag) => args.includes(flag));
  if (platforms.length > 1 || architectures.length > 1) throw new Error('Package one platform and architecture per staged helper runtime.');
  return { platform: ({ '--mac': 'darwin', '--win': 'win32', '--linux': 'linux' })[platforms[0]] || host.platform, arch: architectures[0]?.slice(2) || host.arch };
}
export function verifyHelperTarget(manifest, target) {
  if (manifest?.schema !== 1 || manifest.protocol !== 'nyora-desktop-helper/1' || manifest.platform !== target.platform || manifest.arch !== target.arch) throw new Error(`Stage a verified native helper/JRE for ${target.platform}/${target.arch} before packaging this target.`);
}
