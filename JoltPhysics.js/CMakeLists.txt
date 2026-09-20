cmake_minimum_required(VERSION 3.13 FATAL_ERROR)
set(CMAKE_POLICY_DEFAULT_CMP0077 NEW)

# --- WINDOWS FIXES ---
# Disable PCH to fix the "clang++: error: -x c++-header" issue
set(CMAKE_DISABLE_PRECOMPILE_HEADERS ON)
# Don't treat warnings as errors
add_compile_options(-Wno-error)
# ---------------------

FIND_PACKAGE(Python3 COMPONENTS Interpreter REQUIRED)
set(PYTHON ${Python3_EXECUTABLE} CACHE STRING "Python path")

# --- HELPER SCRIPTS GENERATION ---
# We generate python scripts to replace 'sed' and 'cat' for Windows compatibility

# 1. Script to merge files (cat)
set(MERGE_SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/jolt_merge.py")
file(WRITE ${MERGE_SCRIPT} "
import sys
outfile = sys.argv[1]
infiles = sys.argv[2:]
with open(outfile, 'w', encoding='utf-8') as out:
    for f in infiles:
        with open(f, 'r', encoding='utf-8') as i:
            out.write(i.read())
")

# 2. Script to replace text (sed)
set(REPLACE_SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/jolt_replace.py")
file(WRITE ${REPLACE_SCRIPT} "
import sys
import os
# Usage: python replace.py <pattern> <replacement> <file>
# Usage: python replace.py <pattern> <file> (Implies replacement is empty string)
args = sys.argv[1:]
if len(args) == 3:
    pat, rep, fn = args[0], args[1], args[2]
elif len(args) == 2:
    pat, rep, fn = args[0], '', args[1]
else:
    sys.exit(1)

if os.path.exists(fn):
    with open(fn, 'r', encoding='utf-8') as f: s = f.read()
    s = s.replace(pat, rep)
    with open(fn, 'w', encoding='utf-8') as f: f.write(s)
")
# ---------------------------------

set(EMSCRIPTEN_ROOT $ENV{EMSDK}/upstream/emscripten CACHE STRING "Emscripten path")
set(CMAKE_TOOLCHAIN_FILE ${EMSCRIPTEN_ROOT}/cmake/Modules/Platform/Emscripten.cmake)
set(WEBIDL_BINDER_SCRIPT ${EMSCRIPTEN_ROOT}/tools/webidl_binder.py)

# Input Files
set(JOLT_FRONT_MATTER_FILE ${CMAKE_CURRENT_SOURCE_DIR}/front-matter.js)
set(JOLT_HEADER_FILE ${CMAKE_CURRENT_SOURCE_DIR}/JoltJS.h)
set(JOLT_IDL_BASE ${CMAKE_CURRENT_SOURCE_DIR}/JoltJS.idl)
set(JOLT_IDL_DEBUG ${CMAKE_CURRENT_SOURCE_DIR}/JoltJS-DebugRenderer.idl)

# Output Paths
set(OUTPUT_FOLDER ${CMAKE_CURRENT_SOURCE_DIR}/dist/)
set(JOLT_TYPING ${OUTPUT_FOLDER}/types.d.ts)

# Options
option(ENABLE_MEMORY_PROFILER "Enable memory profiler" OFF)
option(DOUBLE_PRECISION "Double precision mode" OFF)
option(ENABLE_MULTI_THREADING "Multi threading mode" OFF)
option(ENABLE_SIMD "Enable SIMD" OFF)
option(BUILD_WASM_COMPAT_ONLY "Compile only WASM compat" OFF)
option(ALLOW_MEMORY_GROWTH "Allow Memory Growth" OFF)

set(INITIAL_MEMORY 134217728 CACHE STRING "Initial Memory")
set(MAXIMUM_MEMORY 2147483648 CACHE STRING "Maximum Memory")

set(CMAKE_CONFIGURATION_TYPES "Debug;Release;Distribution")

# Config flags
set(DISABLE_CUSTOM_ALLOCATOR ON)
set(ENABLE_OBJECT_STREAM OFF)
set(OBJECT_LAYER_BITS 32)

# Multi-threading Setup
if (ENABLE_MULTI_THREADING)
    set(MULTI_THREADED_FLAG -pthread --post-js ${CMAKE_CURRENT_SOURCE_DIR}/multi-threaded.js -s SHARED_MEMORY)
    set(ENVIRONMENT_FLAG -s ENVIRONMENT=web,node,worker -s PTHREAD_POOL_SIZE=16)
    set(CMAKE_CXX_FLAGS "-pthread -s SHARED_MEMORY")
    set(OUTPUT_BASE_NAME "${OUTPUT_FOLDER}jolt-physics.multithread")
    # Remove thread_local using python helper
    set(REMOVE_THREAD_LOCAL ${PYTHON} ${REPLACE_SCRIPT} "thread_local" "glue.cpp")
else()
    set(MULTI_THREADED_FLAG "")
    set(ENVIRONMENT_FLAG -s ENVIRONMENT=web,node,worker)
    set(OUTPUT_BASE_NAME "${OUTPUT_FOLDER}jolt-physics")
    set(REMOVE_THREAD_LOCAL ${CMAKE_COMMAND} -E echo "Single threaded build")
endif()

# SIMD Setup
if (ENABLE_SIMD)
    set(ENABLE_SIMD_FLAG -msimd128 -msse4.2)
else()
    set(ENABLE_SIMD_FLAG "")
endif()

# Fetch Jolt Source
include(FetchContent)
FetchContent_Declare(
    JoltPhysics
    GIT_REPOSITORY "https://github.com/jrouwe/JoltPhysics"
    GIT_TAG "v5.4.0"
    SOURCE_SUBDIR "Build"
)
FetchContent_MakeAvailable(JoltPhysics)

# Emscripten Flags
set(EMCC_ARGS
  --extern-pre-js ${JOLT_FRONT_MATTER_FILE}
  --post-js glue.js
  --closure=1
  --closure-args="--dynamic_import_alias=replace_by_import"
  --closure-args="--externs"
  --closure-args="${CMAKE_CURRENT_SOURCE_DIR}/extern-import.js"
  ${MULTI_THREADED_FLAG}
  --post-js ${CMAKE_CURRENT_SOURCE_DIR}/helpers.js
  -s ALLOW_TABLE_GROWTH=1
  -s WASM_BIGINT=0
  ${ENVIRONMENT_FLAG}
  -s EXPORT_ES6=1
  -s EXPORT_NAME="Jolt"
  -s MODULARIZE=1
  -s NO_EXIT_RUNTIME=1
  -s NO_FILESYSTEM=1
  -s STACK_SIZE=1048576
  -s INITIAL_MEMORY=${INITIAL_MEMORY}
  -s EXPORTED_RUNTIME_METHODS=HEAP8,HEAPU8,HEAP16,HEAPU16,HEAP32,HEAPU32,HEAPF32,HEAPF64
  ${ENABLE_SIMD_FLAG}
)

if (ALLOW_MEMORY_GROWTH)
    list(APPEND EMCC_ARGS -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=${MAXIMUM_MEMORY})
endif()

if ("${CMAKE_BUILD_TYPE}" STREQUAL "Debug")
    list(APPEND EMCC_ARGS -gsource-map -s ASSERTIONS)
    set(DEBUG_DEF -D_DEBUG -DJPH_DEBUG_RENDERER -DJPH_PROFILE_ENABLED)
    set(IDL_FILES ${JOLT_IDL_BASE} ${JOLT_IDL_DEBUG})
else()
    list(APPEND EMCC_ARGS -O3)
    set(DEBUG_DEF -DNDEBUG)
    # Release mode usually only needs base IDL unless you specifically want debug renderer
    set(IDL_FILES ${JOLT_IDL_BASE} ${JOLT_IDL_DEBUG}) 
endif()

if (DOUBLE_PRECISION)
    list(APPEND EMCC_ARGS -DJPH_DOUBLE_PRECISION)
    set(DOUBLE_DEF -DJPH_DOUBLE_PRECISION)
endif()

# Target Arguments
set(EMCC_JS_ARGS ${EMCC_ARGS} -s AGGRESSIVE_VARIABLE_ELIMINATION=1 -s SINGLE_FILE=1 -s WASM=0)
set(EMCC_WASM_ARGS ${EMCC_ARGS} -s BINARYEN_IGNORE_IMPLICIT_TRAPS=1 -s WASM=1)
set(EMCC_WASM_COMPAT_ARGS ${EMCC_WASM_ARGS} -s SINGLE_FILE=1)

set(EMCC_GLUE_ARGS -c -I${JoltPhysics_SOURCE_DIR}/.. -Wall -std=c++17 -fno-rtti -fno-exceptions 
    ${MULTI_THREADED_FLAG} -DJPH_OBJECT_LAYER_BITS=32 -DJPH_DISABLE_CUSTOM_ALLOCATOR 
    -include ${JOLT_HEADER_FILE} ${ENABLE_SIMD_FLAG} ${DEBUG_DEF} ${DOUBLE_DEF})

# --- BUILD TARGETS ---

project("JoltPhysics.js")

# 1. Generate Types
add_custom_command(
    OUTPUT ${JOLT_TYPING}
    COMMAND npx webidl-dts-gen -e -d -i jolt.idl -o ${JOLT_TYPING} -n Jolt
    DEPENDS jolt.idl
    COMMENT "Generating TypeScript definitions"
)

# 2. Merge IDL and Generate Glue
add_custom_command(
    OUTPUT glue.cpp glue.js jolt.idl
    BYPRODUCTS parser.out WebIDLGrammar.pkl
    # Merge IDLs using python
    COMMAND ${PYTHON} ${MERGE_SCRIPT} jolt.idl ${IDL_FILES}
    # Generate Glue
    COMMAND ${PYTHON} ${WEBIDL_BINDER_SCRIPT} jolt.idl glue
    # Remove thread_local if necessary
    COMMAND ${REMOVE_THREAD_LOCAL}
    DEPENDS ${IDL_FILES}
    COMMENT "Generating bindings"
)

# 3. Compile Glue
add_custom_command(
    OUTPUT glue.o
    COMMAND emcc glue.cpp ${EMCC_GLUE_ARGS} -o glue.o
    DEPENDS glue.cpp ${JOLT_HEADER_FILE}
    COMMENT "Compiling glue code"
)
add_custom_target(jolt-bindings ALL DEPENDS glue.js glue.o ${JOLT_TYPING})

# 4. Link Targets

# Helper to fix imports in generated JS using python
set(FIX_IMPORTS ${PYTHON} ${REPLACE_SCRIPT} "replace_by_import" "import")

if (NOT BUILD_WASM_COMPAT_ONLY)
    # JS Target
    add_custom_command(
        OUTPUT ${OUTPUT_BASE_NAME}.js
        COMMAND emcc glue.o $<TARGET_FILE:Jolt> ${EMCC_JS_ARGS} -o ${OUTPUT_BASE_NAME}.js
        DEPENDS jolt-bindings ${JOLT_FRONT_MATTER_FILE}
        COMMENT "Linking JS version"
    )
    add_custom_target(jolt-javascript ALL DEPENDS ${OUTPUT_BASE_NAME}.js)

    # WASM Target
    add_custom_command(
        OUTPUT ${OUTPUT_BASE_NAME}.wasm.js
        COMMAND emcc glue.o $<TARGET_FILE:Jolt> ${EMCC_WASM_ARGS} -o ${OUTPUT_BASE_NAME}.wasm.js
        COMMAND ${FIX_IMPORTS} ${OUTPUT_BASE_NAME}.wasm.js
        DEPENDS jolt-bindings ${JOLT_FRONT_MATTER_FILE}
        COMMENT "Linking WASM version"
    )
    add_custom_target(jolt-wasm ALL DEPENDS ${OUTPUT_BASE_NAME}.wasm.js)
endif()

# WASM Compat Target
add_custom_command(
    OUTPUT ${OUTPUT_BASE_NAME}.wasm-compat.js
    COMMAND emcc glue.o $<TARGET_FILE:Jolt> ${EMCC_WASM_COMPAT_ARGS} -o ${OUTPUT_BASE_NAME}.wasm-compat.js
    COMMAND ${FIX_IMPORTS} ${OUTPUT_BASE_NAME}.wasm-compat.js
    DEPENDS jolt-bindings ${JOLT_FRONT_MATTER_FILE}
    COMMENT "Linking WASM Compat version"
)
add_custom_target(jolt-wasm-compat ALL DEPENDS ${OUTPUT_BASE_NAME}.wasm-compat.js)