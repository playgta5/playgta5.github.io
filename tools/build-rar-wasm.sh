#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${BUILD_ROOT:-$ROOT/.build}"
SRC="${LIBARCHIVE_SOURCE:-$BUILD_ROOT/libarchive-src}"
BUILD="${LIBARCHIVE_BUILD:-$BUILD_ROOT/libarchive-wasm-build}"
OUT="$ROOT/vendor/libarchive"

if [[ ! -f "$SRC/CMakeLists.txt" ]]; then
  mkdir -p "$(dirname "$SRC")"
  echo "Fetching libarchive source into $SRC"
  git clone --depth 1 https://github.com/libarchive/libarchive.git "$SRC"
fi

mkdir -p "$BUILD" "$OUT"
emcmake cmake -S "$SRC" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DHAVE_ARC4RANDOM_BUF:INTERNAL=0 \
  -DHAVE__FSEEKI64:INTERNAL=0 \
  -DHAVE_CLOSEFROM:INTERNAL=0 \
  -DHAVE_CLOSE_RANGE:INTERNAL=0 \
  -DENABLE_TEST=OFF -DENABLE_INSTALL=OFF \
  -DENABLE_TAR=OFF -DENABLE_CPIO=OFF -DENABLE_CAT=OFF -DENABLE_UNZIP=OFF \
  -DENABLE_ZLIB=OFF -DENABLE_BZip2=OFF -DENABLE_LZMA=OFF -DENABLE_ZSTD=OFF \
  -DENABLE_LZ4=OFF -DENABLE_LZO=OFF -DENABLE_OPENSSL=OFF -DENABLE_MBEDTLS=OFF \
  -DENABLE_NETTLE=OFF -DENABLE_MD=OFF -DENABLE_LIBB2=OFF \
  -DENABLE_LIBXML2=OFF -DENABLE_BSDXML=OFF -DENABLE_EXPAT=OFF \
  -DENABLE_PCREPOSIX=OFF -DENABLE_PCRE2POSIX=OFF -DENABLE_LIBGCC=OFF \
  -DENABLE_XATTR=OFF -DENABLE_ACL=OFF -DENABLE_ICONV=OFF -DENABLE_CNG=OFF
cmake --build "$BUILD" --target archive_static --parallel "${JOBS:-2}"

emcc "$ROOT/tools/archive_stream.c" "$BUILD/libarchive/libarchive.a" \
  -I"$SRC/libarchive" -I"$BUILD/libarchive" \
  -O3 -flto \
  -sWASM=1 -Wl,--no-entry -sMODULARIZE=1 -sEXPORT_NAME=createLibarchiveModule \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=2147483648 \
  -sENVIRONMENT=worker -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_FUNCTIONS='["_rar_open","_rar_next","_rar_path","_rar_size","_rar_type","_rar_read","_rar_error","_rar_close","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["FS","WORKERFS","UTF8ToString","stringToUTF8"]' \
  -lworkerfs.js \
  -o "$OUT/archive.js"
cp "$SRC/COPYING" "$OUT/COPYING-libarchive.txt"
echo "Built $OUT/archive.js and $OUT/archive.wasm"
