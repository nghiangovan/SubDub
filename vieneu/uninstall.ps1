# SubDub - go giong VieNeu. Tep nay phai luu dang UTF-8 co BOM.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$HostName = 'com.subdub.vieneu'
$Root     = Join-Path $env:LOCALAPPDATA 'SubDub\vieneu'
$Key      = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

function Wait-Key {
    Write-Host ''
    Write-Host 'Nhấn phím bất kỳ để đóng...' -ForegroundColor Yellow
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { try { Read-Host | Out-Null } catch { } }
}

$exitCode = 0
try {
    Write-Host ''
    Write-Host '==============================================' -ForegroundColor Cyan
    Write-Host '  SubDub - Gỡ giọng đọc VieNeu' -ForegroundColor Cyan
    Write-Host '==============================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'Sẽ xóa:'
    Write-Host "  - Thư mục $Root (khoảng 550 MB: Python, mô hình giọng)"
    Write-Host '  - Mục đăng ký với Chrome của giọng VieNeu'
    Write-Host 'SubDub và giọng Google không bị ảnh hưởng.'
    Write-Host ''
    $answer = Read-Host 'Bạn có chắc muốn gỡ? Gõ Y rồi Enter để gỡ, N để hủy (Y/N)'
    if ($answer -notmatch '^\s*[YyCc]') {
        Write-Host 'Đã hủy, không có gì bị xóa.'
    } else {
        Write-Host ''
        Write-Host '[1/3] Đóng giọng VieNeu nếu đang chạy'
        try {
            Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase) } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Milliseconds 800
        } catch { }

        Write-Host '[2/3] Xóa mục đăng ký với Chrome'
        if (Test-Path -LiteralPath $Key) { Remove-Item -LiteralPath $Key -Recurse -Force }

        Write-Host '[3/3] Xóa thư mục cài đặt'
        if (Test-Path -LiteralPath $Root) {
            $done = $false
            for ($i = 1; $i -le 5 -and -not $done; $i++) {
                try { Remove-Item -LiteralPath $Root -Recurse -Force; $done = $true }
                catch { Start-Sleep -Seconds 2 }
            }
            if (-not $done) { throw "Không xóa hết được $Root (có thể Chrome hoặc phần mềm khác đang dùng). Hãy đóng Chrome rồi chạy lại." }
        }
        $parent = Split-Path $Root -Parent
        if ((Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force)) {
            Remove-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue
        }
        Write-Host ''
        Write-Host 'Đã gỡ giọng VieNeu. SubDub sẽ tự dùng giọng Google.' -ForegroundColor Green
    }
}
catch {
    $exitCode = 1
    Write-Host ''
    Write-Host ('Gỡ chưa thành công: ' + $_.Exception.Message) -ForegroundColor Red
}
Wait-Key
exit $exitCode
