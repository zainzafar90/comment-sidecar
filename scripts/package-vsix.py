#!/usr/bin/env python3
"""Create a local unsigned VSIX using only Python's standard library."""
from pathlib import Path
from xml.sax.saxutils import escape
import json
import zipfile
import xml.etree.ElementTree as ET
from stable_zip import write_entry

MEDIA_TYPES = {
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.png': 'image/png',
}

root = Path(__file__).resolve().parents[1]
pkg = json.loads((root / 'package.json').read_text(encoding='utf-8'))
(root / 'dist').mkdir(exist_ok=True)
output = root / 'dist' / f"{pkg['name']}-{pkg['version']}.vsix"
icon = pkg.get('icon')
if icon and not (root / icon).is_file():
    raise RuntimeError(f'package.json icon does not exist: {icon}')
icon_metadata = f"\n    <Icon>extension/{escape(icon)}</Icon>" if icon else ''
icon_asset = f'\n    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{escape(icon)}" Addressable="true" />' if icon else ''
files = [root / 'package.json', root / 'README.md', root / 'LICENSE']
for folder in ['src', 'media', 'integration']:
    files.extend(path for path in (root / folder).rglob('*') if path.is_file() and path.suffix != '.comment')
files.extend(root / name for name in ['FORMAT.md', 'SECURITY.md'] if (root / name).exists())
suffixes = sorted({file.suffix for file in files if file.suffix})
unknown = [suffix for suffix in suffixes if suffix not in MEDIA_TYPES]
if unknown:
    raise RuntimeError(f'Add a media type for {", ".join(unknown)} to package-vsix.py')
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(pkg['name'])}" Version="{escape(pkg['version'])}" Publisher="{escape(pkg['publisher'])}" />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags>{escape(','.join(pkg['keywords']))}</Tags>
    <Categories>{escape(','.join(pkg['categories']))}</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{escape(','.join(pkg['extensionKind']))}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
    </Properties>
    <License>extension/LICENSE</License>{icon_metadata}
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />{icon_asset}
  </Assets>
</PackageManifest>
'''
defaults = ''.join(f'\n  <Default Extension="{suffix[1:]}" ContentType="{MEDIA_TYPES[suffix]}" />' for suffix in suffixes)
content_types = f'''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{defaults}
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>
'''
ET.fromstring(manifest)
ET.fromstring(content_types)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, value in [('extension.vsixmanifest', manifest), ('[Content_Types].xml', content_types)]:
        write_entry(archive, name, value)
    for file in sorted(files):
        if file.is_symlink():
            raise RuntimeError(f'Refusing a symlink in the release: {file}')
        write_entry(archive, f"extension/{file.relative_to(root).as_posix()}", file.read_bytes())
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    stored = json.loads(archive.read('extension/package.json'))
    assert f"extension/{stored['main'].removeprefix('./')}" in archive.namelist()
print(f'{output} ({output.stat().st_size:,} bytes; {len(files)} extension files)')
