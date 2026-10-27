# SubDub - cai dat giong VieNeu (chay tren may, mien phi). Tep nay phai luu dang UTF-8 co BOM.
# Khong can quyen quan tri. Chay lai nhieu lan van an toan (sua / cap nhat).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest hien thanh tien do rat cham tren PowerShell 5.1
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$HostName   = 'com.subdub.vieneu'
$ExtOrigin  = 'chrome-extension://cbbadcdbccjlgmmnihmnlpbehdcidoeh/'
$UvVersion  = '0.12.24'
$UvUrl      = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"
$UvSha256   = '7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019'
$Root       = Join-Path $env:LOCALAPPDATA 'SubDub\vieneu'
$Src        = $PSScriptRoot
$Total      = 7

function Write-Step([int]$n, [string]$text) {
    Write-Host ''
    Write-Host ("[{0}/{1}] {2}" -f $n, $Total, $text) -ForegroundColor Cyan
}
function Write-Ok([string]$text)   { Write-Host ("   OK  " + $text) -ForegroundColor Green }
function Write-Note([string]$text) { Write-Host ("   " + $text) -ForegroundColor Gray }

function Wait-Key {
    Write-Host ''
    Write-Host 'Nhấn phím bất kỳ để đóng...' -ForegroundColor Yellow
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { try { Read-Host | Out-Null } catch { } }
}

function Invoke-Native([string]$exe, [string[]]$arguments, [string]$errorText) {
    # Chay chuong trinh ngoai; chu thich loi cua chuong trinh (stderr) khong bi coi la loi PowerShell.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $exe @arguments } finally { $ErrorActionPreference = $old }
    if ($LASTEXITCODE -ne 0) {
        if ($errorText) { throw $errorText }
        throw ("Lệnh '{0}' báo lỗi (mã {1})." -f (Split-Path $exe -Leaf), $LASTEXITCODE)
    }
}

function Get-File([string]$url, [string]$dest) {
    for ($i = 1; $i -le 3; $i++) {
        try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; return }
        catch {
            if ($i -eq 3) { throw }
            Write-Note ("Tải lần $i chưa được, thử lại sau vài giây...")
            Start-Sleep -Seconds (2 * $i)
        }
    }
}

function Stop-VieNeuProcesses {
    # Dong giong VieNeu dang chay (neu co) de co the cap nhat tep.
    try {
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase) } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
    } catch { }
}

$transcript = $false
$exitCode = 0
try {
    Write-Host ''
    Write-Host '==============================================' -ForegroundColor Cyan
    Write-Host '  SubDub - Cài giọng đọc VieNeu (chạy trên máy)' -ForegroundColor Cyan
    Write-Host '==============================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'Giọng VieNeu nghe tự nhiên hơn, chạy ngay trên máy bạn, hoàn toàn miễn phí.'
    Write-Host 'Việc cài đặt cần Internet và mất khoảng 3-8 phút (tải khoảng 350 MB, chỉ một lần).'
    Write-Host 'Không cần quyền quản trị và không cài gì vào hệ thống. Bạn có thể gỡ bằng Go-giong-VieNeu.bat.'

    # ---- 1. kiem tra may ----
    Write-Step 1 'Kiểm tra máy'
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'Giọng VieNeu chỉ chạy trên Windows 64-bit. SubDub vẫn dùng giọng Google bình thường.'
    }
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    try { Start-Transcript -Path (Join-Path $Root 'install-log.txt') -Force | Out-Null; $transcript = $true } catch { }
    $freeGb = $null
    try { $freeGb = (Get-Item -LiteralPath $Root).PSDrive.Free / 1GB } catch { }
    if ($freeGb -ne $null -and $freeGb -lt 1.5) {
        throw ("Ổ đĩa còn trống {0:N1} GB, cần ít nhất 1,5 GB. Hãy giải phóng dung lượng rồi chạy lại." -f $freeGb)
    }
    Write-Ok "Windows 64-bit, thư mục cài: $Root"

    Stop-VieNeuProcesses

    # ---- 2. uv ----
    Write-Step 2 'Tải công cụ cài đặt nhỏ (uv, khoảng 15 MB)'
    $toolsDir = Join-Path $Root 'tools'
    $uv = Join-Path $toolsDir 'uv.exe'
    $haveUv = $false
    if (Test-Path -LiteralPath $uv) {
        try { $haveUv = ((& $uv --version) -match [regex]::Escape($UvVersion)) } catch { $haveUv = $false }
    }
    if ($haveUv) {
        Write-Ok 'Đã có sẵn, bỏ qua bước tải.'
    } else {
        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        $zip = Join-Path $toolsDir 'uv.zip'
        Get-File $UvUrl $zip
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
        if ($hash -ne $UvSha256) {
            Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
            throw 'Tệp tải về bị sai mã kiểm tra (có thể do mạng hoặc phần mềm diệt virus). Hãy thử lại.'
        }
        Expand-Archive -LiteralPath $zip -DestinationPath $toolsDir -Force
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $uv)) { throw 'Giải nén uv không thành công.' }
        Write-Ok 'Đã tải và kiểm tra tệp: đạt.'
    }

    # moi thu cua uv nam trong thu muc cai dat de go sach duoc
    $env:UV_CACHE_DIR = Join-Path $Root 'cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $Root 'python'
    $env:UV_PYTHON_PREFERENCE = 'only-managed'
    $env:UV_NO_CONFIG = '1'

    # ---- 3. python ----
    Write-Step 3 'Cài Python riêng cho giọng đọc (khoảng 30 MB, không ảnh hưởng Python khác của bạn)'
    Invoke-Native $uv @('python', 'install', '3.12')
    Write-Ok 'Python sẵn sàng.'

    # ---- 4. moi truong + thu vien ----
    Write-Step 4 'Tạo môi trường và cài thư viện (onnxruntime, numpy, sea-g2p)'
    $venv = Join-Path $Root 'venv'
    $py = Join-Path $venv 'Scripts\python.exe'
    Invoke-Native $uv @('venv', $venv, '--python', '3.12', '--allow-existing')
    Invoke-Native $uv @('pip', 'install', '--python', $py, '--link-mode', 'copy', '-r', (Join-Path $Src 'requirements.txt'))
    Write-Ok 'Đã cài xong thư viện.'

    # ---- 5. host + manifest + registry ----
    Write-Step 5 'Cài đặt chương trình giọng đọc và kết nối với Chrome'
    Copy-Item -LiteralPath (Join-Path $Src 'host.py') -Destination (Join-Path $Root 'host.py') -Force
    Copy-Item -LiteralPath (Join-Path $Src 'requirements.txt') -Destination (Join-Path $Root 'requirements.txt') -Force
    $runHost = Join-Path $Root 'run-host.bat'
    $bat = "@echo off`r`n`"%~dp0venv\Scripts\python.exe`" -u -I `"%~dp0host.py`" %*`r`n"
    [System.IO.File]::WriteAllText($runHost, $bat, [System.Text.Encoding]::ASCII)

    $manifestPath = Join-Path $Root "$HostName.json"
    $manifest = [ordered]@{
        name            = $HostName
        description     = 'SubDub - local VieNeu voice'
        path            = $runHost
        type            = 'stdio'
        allowed_origins = @($ExtOrigin)
    }
    $json = $manifest | ConvertTo-Json -Depth 4
    # JSON khong BOM de Chrome doc duoc
    [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

    $key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
    Write-Ok 'Đã đăng ký với Chrome (không cần khởi động lại Chrome).'

    # ---- 6. tai mo hinh + chay thu ----
    Write-Step 6 'Tải mô hình giọng (khoảng 285 MB) và chạy thử'
    Write-Note 'Bước này lâu nhất, xin đừng đóng cửa sổ. Nếu bị gián đoạn, chạy lại tệp này để tải tiếp.'
    Write-Host ''
    Invoke-Native $py @('-I', (Join-Path $Root 'host.py'), '--download') 'Tải hoặc chạy thử giọng VieNeu không thành công (xem dòng LỖI ở trên).'

    # ---- 7. don dep ----
    Write-Step 7 'Dọn dẹp'
    Remove-Item -LiteralPath (Join-Path $Root 'cache') -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok 'Xong.'

    Write-Host ''
    Write-Host '==============================================' -ForegroundColor Green
    Write-Host '  CÀI ĐẶT THÀNH CÔNG!' -ForegroundColor Green
    Write-Host '==============================================' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Bước tiếp theo:'
    Write-Host '  1. Mở SubDub (biểu tượng tiện ích trên Chrome).'
    Write-Host '  2. Ở mục giọng đọc, chọn "VieNeu" rồi bấm "Kiểm tra lại" nếu cần.'
    Write-Host '  Giọng chỉ chạy khi đang lồng tiếng và tự tắt sau vài phút, không làm nặng máy.'
}
catch {
    $exitCode = 1
    Write-Host ''
    Write-Host '==============================================' -ForegroundColor Red
    Write-Host '  CÀI ĐẶT CHƯA THÀNH CÔNG' -ForegroundColor Red
    Write-Host '==============================================' -ForegroundColor Red
    Write-Host ''
    $ex = $_.Exception
    if ($ex -is [System.Net.WebException]) {
        Write-Host 'Không kết nối được Internet hoặc máy chủ tải tệp. Hãy kiểm tra mạng rồi chạy lại.' -ForegroundColor Yellow
    } elseif ($ex -is [System.IO.IOException] -and (($ex.HResult -band 0xFFFF) -eq 112)) {
        Write-Host 'Ổ đĩa đã đầy. Hãy giải phóng ít nhất 1,5 GB rồi chạy lại.' -ForegroundColor Yellow
    } else {
        Write-Host 'Nguyên nhân thường gặp: mất Internet giữa chừng, ổ đĩa đầy, hoặc phần mềm diệt virus chặn tệp.' -ForegroundColor Yellow
    }
    Write-Host ('Chi tiết: ' + $ex.Message) -ForegroundColor Gray
    Write-Host 'Bạn cứ chạy lại Cai-giong-VieNeu.bat: phần đã tải sẽ được dùng lại. SubDub vẫn dùng giọng Google bình thường.' -ForegroundColor Gray
    Write-Host ('Nhật ký: ' + (Join-Path $Root 'install-log.txt')) -ForegroundColor Gray
}
finally {
    if ($transcript) { try { Stop-Transcript | Out-Null } catch { } }
}
Wait-Key
exit $exitCode
