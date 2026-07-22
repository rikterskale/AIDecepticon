[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("bootstrap", "install", "test", "lint", "format", "run", "clean")]
    [string]$Task = "test"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProjectPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"

function Invoke-External {
    param(
        [string]$Executable,
        [string[]]$Arguments
    )

    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

if ($Task -eq "bootstrap" -and -not (Test-Path -LiteralPath $ProjectPython -PathType Leaf)) {
    $PythonLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($null -ne $PythonLauncher) {
        Invoke-External $PythonLauncher.Source @("-3.12", "-m", "venv", ".venv")
    }
    else {
        $SystemPython = Get-Command python -ErrorAction Stop
        Invoke-External $SystemPython.Source @("-m", "venv", ".venv")
    }
}

if (Test-Path -LiteralPath $ProjectPython -PathType Leaf) {
    $PythonExecutable = $ProjectPython
}
else {
    $PythonExecutable = (Get-Command python -ErrorAction Stop).Source
}

function Invoke-Python {
    param([string[]]$Arguments)

    Invoke-External $PythonExecutable $Arguments
}

Push-Location $ProjectRoot
try {
    switch ($Task) {
        "bootstrap" {
            Invoke-Python @("-m", "pip", "install", "--upgrade", "pip")
            Invoke-Python @("-m", "pip", "install", "-e", ".[dev]")
        }
        "install" {
            Invoke-Python @("-m", "pip", "install", "-e", ".[dev]")
        }
        "test" {
            Invoke-Python @(
                "-m",
                "pytest",
                "--basetemp=.pytest-tmp",
                "--cov=deceptionflow",
                "--cov-report=term-missing",
                "--cov-fail-under=85"
            )
        }
        "lint" {
            Invoke-Python @("-m", "ruff", "check", ".")
        }
        "format" {
            Invoke-Python @("-m", "ruff", "format", ".")
            Invoke-Python @("-m", "ruff", "check", "--fix", ".")
        }
        "run" {
            Invoke-Python @(
                "-m", "deceptionflow", "serve", "--host", "0.0.0.0", "--port", "8080"
            )
        }
        "clean" {
            $ArtifactPaths = @(
                ".pytest_cache",
                ".pytest-tmp",
                ".ruff_cache",
                ".coverage",
                "htmlcov",
                "build",
                "dist"
            )

            foreach ($ArtifactPath in $ArtifactPaths) {
                if (Test-Path -LiteralPath $ArtifactPath) {
                    Remove-Item -LiteralPath $ArtifactPath -Recurse -Force
                }
            }

            Get-ChildItem -Path $ProjectRoot -Directory -Filter "*.egg-info" |
                Remove-Item -Recurse -Force
        }
    }
}
finally {
    Pop-Location
}
