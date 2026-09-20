@echo off
setlocal

:: 1. Setup paths
:: Adjust these to match your installation
set EMSDK_PATH=C:\Dev\emsdk
set PYTHON_PATH=C:\Users\hyper\AppData\Local\Python\pythoncore-3.14-64\python.exe

:: 2. Activate Emscripten (Quietly)
call "%EMSDK_PATH%\emsdk_env.bat" >nul 2>&1

:: 3. Clean previous build (Optional, good for debugging)
if exist build rmdir /s /q build
mkdir build

:: 4. Configure
:: We use -DCMAKE_MAKE_PROGRAM to ensure we use the right tool if needed, 
:: but usually standard emcmake cmake -B build works fine on Windows now.
echo Configuring...
call emcmake cmake -B build ^
    -DPython3_EXECUTABLE="%PYTHON_PATH%" ^
    -DCMAKE_BUILD_TYPE=Release ^
    -DALLOW_MEMORY_GROWTH=ON

:: 5. Build
:: --build . abstracts away "ninja" or "make" or "nmake"
echo Building...
cd build
cmake --build . --config Release --parallel 4

echo Done.
pause