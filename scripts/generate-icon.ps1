Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$buildDir = Join-Path $root 'build'
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

function New-RoundedRectanglePath {
  param(
    [System.Drawing.RectangleF]$Rect,
    [float]$Radius
  )

  $diameter = $Radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($Rect.X, $Rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Rect.X, $Rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-WorkSpacesBitmap {
  param([int]$Size)

  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  # Design is authored in a 256x256 space (matches app-icon.svg); scale to $Size.
  $s = $Size / 256.0

  # Black "Onyx" squircle badge.
  $rect = [System.Drawing.RectangleF]::new(0, 0, $Size, $Size)
  $path = New-RoundedRectanglePath -Rect $rect -Radius ($Size * 0.22)
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#000000'))
  $graphics.FillPath($brush, $path)

  # Hairline border so the black badge stays defined on dark surfaces.
  $borderInset = 2 * $s
  $borderRect = [System.Drawing.RectangleF]::new($borderInset, $borderInset, $Size - 2 * $borderInset, $Size - 2 * $borderInset)
  $borderPath = New-RoundedRectanglePath -Rect $borderRect -Radius ($Size * 0.211)
  $borderPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#3a3a3a'), 3 * $s)
  $graphics.DrawPath($borderPen, $borderPath)

  # Terminal chevron ">" — round caps/joins, matches the SVG stroke.
  $glyphPen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 18 * $s)
  $glyphPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $glyphPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $glyphPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  [System.Drawing.PointF[]]$chevron = @(
    [System.Drawing.PointF]::new(78 * $s, 92 * $s),
    [System.Drawing.PointF]::new(118 * $s, 128 * $s),
    [System.Drawing.PointF]::new(78 * $s, 164 * $s)
  )
  $graphics.DrawLines($glyphPen, $chevron)

  # Cursor block (rounded rect).
  $cursorRect = [System.Drawing.RectangleF]::new(134 * $s, 150 * $s, 52 * $s, 16 * $s)
  $cursorPath = New-RoundedRectanglePath -Rect $cursorRect -Radius (8 * $s)
  $graphics.FillPath([System.Drawing.Brushes]::White, $cursorPath)

  $cursorPath.Dispose()
  $glyphPen.Dispose()
  $borderPen.Dispose()
  $borderPath.Dispose()
  $brush.Dispose()
  $path.Dispose()
  $graphics.Dispose()

  return $bitmap
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = foreach ($size in $sizes) {
  $bitmap = New-WorkSpacesBitmap -Size $size
  $stream = [System.IO.MemoryStream]::new()
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($size -eq 256) {
    $bitmap.Save((Join-Path $buildDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $bitmap.Dispose()
  [pscustomobject]@{
    Size = $size
    Bytes = $stream.ToArray()
  }
  $stream.Dispose()
}

$icoPath = Join-Path $buildDir 'icon.ico'
$file = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = [System.IO.BinaryWriter]::new($file)

$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$images.Count)

$offset = 6 + (16 * $images.Count)
foreach ($image in $images) {
  $writer.Write([byte]$(if ($image.Size -eq 256) { 0 } else { $image.Size }))
  $writer.Write([byte]$(if ($image.Size -eq 256) { 0 } else { $image.Size }))
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]$image.Bytes.Length)
  $writer.Write([uint32]$offset)
  $offset += $image.Bytes.Length
}

foreach ($image in $images) {
  $writer.Write($image.Bytes)
}

$writer.Dispose()
$file.Dispose()
