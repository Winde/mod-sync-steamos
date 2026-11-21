Add-Type -AssemblyName System.Drawing

# Artwork built from Iconoir's "refresh-double" icon (MIT, Copyright (c) 2021
# Luca Burgio). Attribution and the full licence text are in
# THIRD-PARTY-NOTICES.md and licenses/iconoir.txt.

$root = (Resolve-Path '.').Path
$iconPath = Join-Path $root 'build/icon.png'
$markPath = Join-Path $root 'build/logo-mark.png'
$outDir = Join-Path $root 'packaging/steam-art'
$webDir = Join-Path $root 'web'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$icon = [System.Drawing.Image]::FromFile($iconPath)
$mark = [System.Drawing.Image]::FromFile($markPath)

$bgTop = [System.Drawing.Color]::FromArgb(18, 19, 23)
$bgBottom = [System.Drawing.Color]::FromArgb(8, 9, 11)
$accent = [System.Drawing.Color]::FromArgb(225, 75, 59)
$white = [System.Drawing.Color]::FromArgb(245, 245, 245)
$muted = [System.Drawing.Color]::FromArgb(160, 164, 171)

function New-OpaqueBitmap([int]$w, [int]$h) {
  $bmp = [System.Drawing.Bitmap]::new($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear($bgTop)
  $rect = [System.Drawing.Rectangle]::new(0, 0, $w, $h)
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $bgTop, $bgBottom, 45.0)
  $g.FillRectangle($brush, $rect)
  $brush.Dispose()
  return @($bmp, $g)
}

function New-TransparentBitmap([int]$w, [int]$h) {
  $bmp = [System.Drawing.Bitmap]::new($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)
  return @($bmp, $g)
}

function Draw-Icon($g, [int]$x, [int]$y, [int]$size) {
  $g.DrawImage($icon, $x, $y, $size, $size)
}

function Draw-Text($g, [string]$text, [float]$size, [System.Drawing.FontStyle]$style, [System.Drawing.Color]$color, [float]$x, [float]$y, [float]$width, [string]$align = 'Near') {
  $font = [System.Drawing.Font]::new('Segoe UI', $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = [System.Drawing.SolidBrush]::new($color)
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = [System.Drawing.StringAlignment]$align
  $format.LineAlignment = [System.Drawing.StringAlignment]::Near
  $rect = [System.Drawing.RectangleF]::new($x, $y, $width, ($size * 1.8))
  $g.DrawString($text, $font, $brush, $rect, $format)
  $format.Dispose(); $brush.Dispose(); $font.Dispose()
}

function Save-Bitmap($bmp, $g, [string]$name) {
  $path = Join-Path $outDir $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output $path
}

# Hero 1920x620. Steam layers the logo over the hero, and its library-asset
# guidance says the hero must not contain text. Keep the left side calm so the
# logo stays legible, and add a soft accent glow on the right.
$pair = New-OpaqueBitmap 1920 620
$bmp = $pair[0]; $g = $pair[1]
$glow = [System.Drawing.Drawing2D.GraphicsPath]::new()
$glow.AddEllipse(1160, -160, 1040, 940)
$brush = [System.Drawing.Drawing2D.PathGradientBrush]::new($glow)
$brush.CenterColor = [System.Drawing.Color]::FromArgb(44, 225, 75, 59)
$brush.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, 225, 75, 59))
$g.FillPath($brush, $glow)
$brush.Dispose(); $glow.Dispose()
$alpha = [System.Drawing.Imaging.ImageAttributes]::new()
$matrix = [System.Drawing.Imaging.ColorMatrix]::new()
$matrix.Matrix33 = 0.12
$alpha.SetColorMatrix($matrix)
$dest = [System.Drawing.Rectangle]::new(1240, -60, 820, 820)
$g.DrawImage($mark, $dest, 0, 0, $mark.Width, $mark.Height, [System.Drawing.GraphicsUnit]::Pixel, $alpha)
$alpha.Dispose()
Save-Bitmap $bmp $g 'hero.png' | Out-Null

# Portrait 600x900
$pair = New-OpaqueBitmap 600 900
$bmp = $pair[0]; $g = $pair[1]
Draw-Icon $g 170 170 260
$line = [System.Drawing.SolidBrush]::new($accent)
$g.FillRectangle($line, 240, 490, 120, 5)
$line.Dispose()
Draw-Text $g 'MODSYNC' 76 ([System.Drawing.FontStyle]::Bold) $white 0 520 600 'Center'
Draw-Text $g 'MOD PACK SYNC' 22 ([System.Drawing.FontStyle]::Regular) $accent 0 620 600 'Center'
Draw-Text $g 'STEAMOS / TV FIRST' 18 ([System.Drawing.FontStyle]::Regular) $muted 0 660 600 'Center'
Save-Bitmap $bmp $g 'portrait.png' | Out-Null

# Header 460x215
$pair = New-OpaqueBitmap 460 215
$bmp = $pair[0]; $g = $pair[1]
Draw-Icon $g 26 48 120
$line = [System.Drawing.SolidBrush]::new($accent)
$g.FillRectangle($line, 172, 64, 48, 4)
$line.Dispose()
Draw-Text $g 'MODSYNC' 46 ([System.Drawing.FontStyle]::Bold) $white 172 78 260
Draw-Text $g 'MOD PACK SYNC' 16 ([System.Drawing.FontStyle]::Regular) $accent 174 136 260
Save-Bitmap $bmp $g 'header.png' | Out-Null

# Icon 256x256, transparent outside the icon's rounded square
$pair = New-TransparentBitmap 256 256
$bmp = $pair[0]; $g = $pair[1]
Draw-Icon $g 0 0 256
Save-Bitmap $bmp $g 'icon.png' | Out-Null

# Logo 1280x340, transparent. Steam layers this over the hero, so it carries
# only the logomark and the wordmark. Keeping the canvas tight vertically lets
# Steam show the lockup at a readable size.
$pair = New-TransparentBitmap 1280 340
$bmp = $pair[0]; $g = $pair[1]
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$glyph = 300
$gap = 36
$font = [System.Drawing.Font]::new('Segoe UI', 150, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$format = [System.Drawing.StringFormat]::new()
$format.Alignment = [System.Drawing.StringAlignment]::Near
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$textW = $g.MeasureString('MODSYNC', $font, 1000, $format).Width
$totalW = $glyph + $gap + $textW
$left = (1280 - $totalW) / 2
$top = (340 - $glyph) / 2
$g.DrawImage($mark, [int]$left, [int]$top, $glyph, $glyph)
$brush = [System.Drawing.SolidBrush]::new($white)
$rect = [System.Drawing.RectangleF]::new([float]($left + $glyph + $gap), [float]$top, [float]($textW + 24), [float]$glyph)
$g.DrawString('MODSYNC', $font, $brush, $rect, $format)
$format.Dispose(); $brush.Dispose(); $font.Dispose()
Save-Bitmap $bmp $g 'logo.png' | Out-Null

$icon.Dispose()
$mark.Dispose()

# Copies used by the TV dashboard and the bootstrap register call.
Copy-Item (Join-Path $outDir 'hero.png') (Join-Path $webDir 'modsync-hero.png') -Force
Copy-Item (Join-Path $outDir 'portrait.png') (Join-Path $webDir 'modsync-grid.png') -Force
Copy-Item (Join-Path $outDir 'portrait.png') (Join-Path $webDir 'modsync-portrait.png') -Force
Copy-Item (Join-Path $outDir 'header.png') (Join-Path $webDir 'modsync-header.png') -Force
Copy-Item (Join-Path $outDir 'logo.png') (Join-Path $webDir 'modsync-logo.png') -Force
Copy-Item (Join-Path $outDir 'icon.png') (Join-Path $webDir 'icon.png') -Force

Get-ChildItem $outDir -Filter '*.png' | Select-Object Name, Length
Get-ChildItem $webDir -Filter '*.png' | Select-Object Name, Length
