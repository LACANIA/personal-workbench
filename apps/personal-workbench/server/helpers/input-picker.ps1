param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('file', 'directory')]
  [string]$Kind
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# The Workbench server has no visible desktop window of its own.  A tiny,
# invisible, topmost owner keeps the native dialog in the foreground instead of
# allowing it to open behind the browser that submitted the request.
$owner = [System.Windows.Forms.Form]::new()
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Location = [System.Drawing.Point]::new(-32000, -32000)
$owner.Size = [System.Drawing.Size]::new(1, 1)
$owner.Opacity = 0
$owner.TopMost = $true
$owner.Show()
$owner.Activate()

if ($Kind -eq 'file') {
  $dialog = [System.Windows.Forms.OpenFileDialog]::new()
  $dialog.Title = 'Select a file for Personal Workbench'
  $dialog.CheckFileExists = $true
  $dialog.CheckPathExists = $true
  $dialog.Multiselect = $false
  $dialog.RestoreDirectory = $true
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    @{ canceled = $false; path = $dialog.FileName; kind = 'file' } | ConvertTo-Json -Compress
  } else {
    @{ canceled = $true; path = $null; kind = 'file' } | ConvertTo-Json -Compress
  }
  $dialog.Dispose()
  $owner.Dispose()
  exit 0
}

$folder = [System.Windows.Forms.FolderBrowserDialog]::new()
$folder.Description = 'Select a folder for Personal Workbench'
$folder.ShowNewFolderButton = $false
if ($folder.PSObject.Properties.Name -contains 'UseDescriptionForTitle') {
  $folder.UseDescriptionForTitle = $true
}
$result = $folder.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  @{ canceled = $false; path = $folder.SelectedPath; kind = 'directory' } | ConvertTo-Json -Compress
} else {
  @{ canceled = $true; path = $null; kind = 'directory' } | ConvertTo-Json -Compress
}
$folder.Dispose()
$owner.Dispose()
