// electron-builder cannot edit the Windows executable here without extracting
// winCodeSign, which needs symlink privileges this machine does not grant.
// A local rcedit pass keeps the file metadata (and therefore the Open With
// label) saying Glance while leaving code signing disabled.
const path = require('path');
const rcedit = require('rcedit');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { productName, version } = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  const copyright = `Copyright (c) ${new Date().getFullYear()} NiranjanS8`;
  await rcedit(exePath, {
    'version-string': {
      CompanyName: 'NiranjanS8',
      FileDescription: 'Glance',
      FileVersion: version,
      InternalName: productName,
      LegalCopyright: copyright,
      OriginalFilename: `${productName}.exe`,
      ProductName: productName,
      ProductVersion: version
    },
    'file-version': version,
    'product-version': version
  });
};
