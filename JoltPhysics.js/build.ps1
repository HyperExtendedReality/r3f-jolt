param(
    [string]$BuildType = "Distribution"
)

$ErrorActionPreference = "Stop"

# 1. Clean and Create dist folder
Write-Host "Cleaning dist folder..."
if (Test-Path "dist") { Remove-Item "dist" -Recurse -Force }
New-Item "dist" -ItemType Directory | Out-Null

# Helper function to keep the main logic clean
# We force "Ninja" generator because it is faster and avoids the MSVC error you saw earlier
function Build-Jolt {
    param($Dir, $Type, $ExtraCMakeArgs)
    Write-Host "Building $Type in $Dir..."
    
    # Collect all CMake arguments into an array
    $CMakeArgs = @(
        "-B", $Dir,
        "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=$Type"
    )
    
    # Append any extra arguments passed to the function
    $CMakeArgs += $ExtraCMakeArgs

    # Use 'emcmake' to set up the environment, and use the invocation operator (&)
    # with splatting (@CMakeArgs) to pass the arguments cleanly.
    & emcmake cmake @CMakeArgs
    
    cmake --build $Dir
}

# 2. Build Debug Versions (If the main target isn't Debug)
if ($BuildType -ne "Debug") {
    # Build ST (Single Threaded) Debug
    Build-Jolt -Dir "Build/Debug/ST" -Type "Debug" -ExtraCMakeArgs "-DBUILD_WASM_COMPAT_ONLY=ON $args"
    
    # Build MT (Multi Threaded) Debug
    Build-Jolt -Dir "Build/Debug/MT" -Type "Debug" -ExtraCMakeArgs "-DENABLE_MULTI_THREADING=ON -DENABLE_SIMD=ON -DBUILD_WASM_COMPAT_ONLY=ON $args"

    # Rename output files
    Move-Item "./dist/jolt-physics.wasm-compat.js" "./dist/jolt-physics.debug.wasm-compat.js"
    Move-Item "./dist/jolt-physics.multithread.wasm-compat.js" "./dist/jolt-physics.debug.multithread.wasm-compat.js"
}

# 3. Build Target Versions (Distribution/Release)
# ST
Build-Jolt -Dir "Build/$BuildType/ST" -Type $BuildType -ExtraCMakeArgs $args
# MT
Build-Jolt -Dir "Build/$BuildType/MT" -Type $BuildType -ExtraCMakeArgs "-DENABLE_MULTI_THREADING=ON -DENABLE_SIMD=ON $args"

# 4. Handle Debug Copying (If the main target IS Debug)
if ($BuildType -eq "Debug") {
    Copy-Item "./dist/jolt-physics.wasm-compat.js" "./dist/jolt-physics.debug.wasm-compat.js"
    Copy-Item "./dist/jolt-physics.multithread.wasm-compat.js" "./dist/jolt-physics.debug.multithread.wasm-compat.js"
}

# 5. Patch the Worker URL (sed replacement)
Write-Host "Patching Worker URL..."
$TargetFile = "./dist/jolt-physics.debug.multithread.wasm-compat.js"
(Get-Content $TargetFile) -replace 'jolt-physics.multithread.wasm-compat.js', 'jolt-physics.debug.multithread.wasm-compat.js' | Set-Content $TargetFile

# 6. Create Types Definition file
Write-Host "Creating TypeScript definitions..."
$TypeContent = @"
import Jolt from "./types";

export default Jolt;
export * from "./types";
"@
Set-Content -Path "./dist/jolt-physics.d.ts" -Value $TypeContent

# 7. Copy Type Definitions
$TypesToCopy = @(
    "jolt-physics.wasm.d.ts",
    "jolt-physics.wasm-compat.d.ts",
    "jolt-physics.debug.wasm-compat.d.ts",
    "jolt-physics.multithread.d.ts",
    "jolt-physics.multithread.wasm.d.ts",
    "jolt-physics.multithread.wasm-compat.d.ts",
    "jolt-physics.debug.multithread.wasm-compat.d.ts"
)

foreach ($item in $TypesToCopy) {
    Copy-Item "./dist/jolt-physics.d.ts" "./dist/$item"
}

# 8. Copy to Examples
Write-Host "Copying to Examples..."
if (-not (Test-Path "./Examples/js")) { New-Item "./Examples/js" -ItemType Directory | Out-Null }
Copy-Item "./dist/jolt-physics*.wasm-compat.js" "./Examples/js/"

Write-Host "Build Complete!"