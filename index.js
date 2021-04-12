import { Texture } from "ogl";

/**
 * Loader for Basis Universal GPU Texture Codec.
 *
 * Basis Universal is a "supercompressed" GPU texture and texture video
 * compression system that outputs a highly compressed intermediate file format
 * (.basis) that can be quickly transcoded to a wide variety of GPU texture
 * compression formats.
 *
 * This loader parallelizes the transcoding process across a configurable number
 * of web workers, before transferring the transcoded compressed texture back
 * to the main thread.
 *
 *
 * !This is an adaptation of https://github.com/mrdoob/three.js/blob/master/examples/jsm/loaders/BasisTextureLoader.js!
 */

let cache = {};
const supportedExtensions = [];

let transcoderPath = "/three/basis";
let transcoderBinary = null;
let transcoderPending = null;

let workerLimit = 4;
let workerPool = [];
let workerNextTaskID = 1;
let workerSourceURL = "";
let workerConfig = null;

let gl = undefined;

const taskCache = new WeakMap();

export class BasisTextureLoader {
  constructor(glContext) {
    /* CONSTANTS */
    gl = glContext;

    this.BasisFormat = {
      ETC1S: 0,
      UASTC_4x4: 1,
    };

    this.TranscoderFormat = {
      ETC1: 0,
      ETC2: 1,
      BC1: 2,
      BC3: 3,
      BC4: 4,
      BC5: 5,
      BC7_M6_OPAQUE_ONLY: 6,
      BC7_M5: 7,
      PVRTC1_4_RGB: 8,
      PVRTC1_4_RGBA: 9,
      ASTC_4x4: 10,
      ATC_RGB: 11,
      ATC_RGBA_INTERPOLATED_ALPHA: 12,
      RGBA32: 13,
      RGB565: 14,
      BGR565: 15,
      RGBA4444: 16,
    };

    this.EngineFormat = {
      RGBAFormat: 1023,
      RGBA_ASTC_4x4_Format: 37808,
      RGBA_BPTC_Format: 36492,
      RGBA_ETC2_EAC_Format: 37496,
      RGBA_PVRTC_4BPPV1_Format: 35842,
      RGBA_S3TC_DXT5_Format: 33779,
      RGB_ETC1_Format: 36196,
      RGB_ETC2_Format: 37492,
      RGB_PVRTC_4BPPV1_Format: 35840,
      RGB_S3TC_DXT1_Format: 33776,
    };
  }
  static setTranscoderPath(path) {
    transcoderPath = path;
  }

  async load(
    src,
    {
      // Only props relevant to KTXTexture
      wrapS = gl.CLAMP_TO_EDGE,
      wrapT = gl.CLAMP_TO_EDGE,
      anisotropy = 0,

      // For regular images
      format = gl.RGBA,
      internalFormat = format,
      generateMipmaps = true,
      minFilter = generateMipmaps ? gl.NEAREST_MIPMAP_LINEAR : gl.LINEAR,
      magFilter = gl.LINEAR,
      premultiplyAlpha = false,
      unpackAlignment = 4,
      flipY = true,
    } = {}
  ) {
    this.getSupportedExtensions(gl);

    // Stringify props
    const cacheID =
      src +
      wrapS +
      wrapT +
      anisotropy +
      format +
      internalFormat +
      generateMipmaps +
      minFilter +
      magFilter +
      premultiplyAlpha +
      unpackAlignment +
      flipY +
      gl.renderer.id;

    // Check cache for existing texture
    if (cache[cacheID]) return cache[cacheID];

    const texture = await this.loadBasis(src);

    texture.ext = "basis";
    cache[cacheID] = texture;
    return texture;
  }

  async loadBasis(src) {
    const res = await fetch(src);
    const buffer = await res.arrayBuffer();
    const texture = await this._createTexture([buffer]);
    return texture;
  }

  getSupportedExtensions(gl) {
    workerConfig = {
      astcSupported: !!gl.renderer.getExtension(
        "WEBGL_compressed_texture_astc"
      ),
      etc1Supported: !!gl.renderer.getExtension(
        "WEBGL_compressed_texture_etc1"
      ),
      etc2Supported: !!gl.renderer.getExtension("WEBGL_compressed_texture_etc"),
      dxtSupported: !!gl.renderer.getExtension("WEBGL_compressed_texture_s3tc"),
      bptcSupported: !!gl.renderer.getExtension("EXT_texture_compression_bptc"),
      pvrtcSupported:
        !!gl.renderer.getExtension("WEBGL_compressed_texture_pvrtc") ||
        !!gl.renderer.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc"),
    };
  }

  /** Low-level transcoding API, exposed for use by KTX2Loader. */
  parseInternalAsync(options) {
    var { levels } = options;

    var buffers = new Set();

    for (var i = 0; i < levels.length; i++) {
      buffers.add(levels[i].data.buffer);
    }

    return this._createTexture(Array.from(buffers), {
      ...options,
      lowLevel: true,
    });
  }

  /**
   * @param {ArrayBuffer[]} buffers
   * @param {object?} config
   * @return {Promise<CompressedTexture>}
   */
  _createTexture(buffers, config) {
    var worker;
    var taskID;

    var taskConfig = config || {};
    var taskCost = 0;

    for (var i = 0; i < buffers.length; i++) {
      taskCost += buffers[i].byteLength;
    }

    var texturePending = this._allocateWorker(taskCost)
      .then((_worker) => {
        worker = _worker;
        taskID = workerNextTaskID++;

        return new Promise((resolve, reject) => {
          worker._callbacks[taskID] = { resolve, reject };

          worker.postMessage(
            {
              type: "transcode",
              id: taskID,
              buffers: buffers,
              taskConfig: taskConfig,
            },
            buffers
          );
        });
      })
      .then((message) => {
        var { mipmaps, width, height, format } = message;

        var texture = new Texture(gl, { width, height, generateMipmaps: false });

        mipmaps.isCompressedTexture = true;
        texture.image = mipmaps;
        texture.internalFormat = format;

        if (mipmaps.length > 1) {
          if (texture.minFilter === texture.gl.LINEAR)
            texture.minFilter = texture.gl.NEAREST_MIPMAP_LINEAR;
        } else {
          if (texture.minFilter === texture.gl.NEAREST_MIPMAP_LINEAR)
            texture.minFilter = texture.gl.LINEAR;
        }

        return texture;
      });

    // Note: replaced '.finally()' with '.catch().then()' block - iOS 11 support (#19416)
    texturePending
      .catch(() => true)
      .then(() => {
        if (worker && taskID) {
          worker._taskLoad -= taskCost;
          delete worker._callbacks[taskID];
        }
      });

    // Cache the task result.
    taskCache.set(buffers[0], { promise: texturePending });

    return texturePending;
  }

  async _initTranscoder() {
    if (!transcoderPending) {
      // Load transcoder wrapper.
      var jsContent = fetch(`${transcoderPath}/basis_transcoder.js`).then(
        (response) => {
          return response.text();
        }
      );

      // Load transcoder WASM binary.
      var binaryContent = fetch(`${transcoderPath}/basis_transcoder.wasm`).then(
        (response) => {
          return response.arrayBuffer();
        }
      );

      transcoderPending = Promise.all([jsContent, binaryContent]).then(
        ([jsContent, binaryContent]) => {
          var fn = this.BasisWorker.toString();

          var body = [
            "/* constants */",
            "var _EngineFormat = " + JSON.stringify(this.EngineFormat),
            "var _TranscoderFormat = " + JSON.stringify(this.TranscoderFormat),
            "var _BasisFormat = " + JSON.stringify(this.BasisFormat),
            "/* basis_transcoder.js */",
            jsContent,
            "/* worker */",
            fn.substring(fn.indexOf("{") + 1, fn.lastIndexOf("}")),
          ].join("\n");

          workerSourceURL = URL.createObjectURL(new Blob([body]));
          transcoderBinary = binaryContent;
        }
      );
    }

    return transcoderPending;
  }

  _allocateWorker(taskCost) {
    return this._initTranscoder().then(() => {
      if (workerPool.length < workerLimit) {
        var worker = new Worker(workerSourceURL);

        worker._callbacks = {};
        worker._taskLoad = 0;

        worker.postMessage({
          type: "init",
          config: workerConfig,
          transcoderBinary: transcoderBinary,
        });

        worker.onmessage = function (e) {
          var message = e.data;

          switch (message.type) {
            case "transcode":
              worker._callbacks[message.id].resolve(message);
              break;

            case "error":
              worker._callbacks[message.id].reject(message);
              break;

            default:
              console.error(
                'THREE.BasisTextureLoader: Unexpected message, "' +
                  message.type +
                  '"'
              );
          }
        };

        workerPool.push(worker);
      } else {
        workerPool.sort(function (a, b) {
          return a._taskLoad > b._taskLoad ? -1 : 1;
        });
      }

      var worker = workerPool[workerPool.length - 1];

      worker._taskLoad += taskCost;

      return worker;
    });
  }

  dispose() {
    for (var i = 0; i < workerPool.length; i++) {
      workerPool[i].terminate();
    }

    workerPool.length = 0;

    return this;
  }

  /* WEB WORKER */

  BasisWorker() {
    var config;
    var transcoderPending;
    var BasisModule;

    this.EngineFormat = _EngineFormat; // eslint-disable-line no-undef
    this.TranscoderFormat = _TranscoderFormat; // eslint-disable-line no-undef
    this.BasisFormat = _BasisFormat; // eslint-disable-line no-undef

    onmessage = function (e) {
      var message = e.data;

      switch (message.type) {
        case "init":
          config = message.config;
          init(message.transcoderBinary);
          break;

        case "transcode":
          transcoderPending.then(() => {
            try {
              var { width, height, hasAlpha, mipmaps, format } = message
                .taskConfig.lowLevel
                ? transcodeLowLevel(message.taskConfig)
                : transcode(message.buffers[0]);

              var buffers = [];

              for (var i = 0; i < mipmaps.length; ++i) {
                buffers.push(mipmaps[i].data.buffer);
              }

              self.postMessage(
                {
                  type: "transcode",
                  id: message.id,
                  width,
                  height,
                  hasAlpha,
                  mipmaps,
                  format,
                },
                buffers
              );
            } catch (error) {
              console.error(error);

              self.postMessage({
                type: "error",
                id: message.id,
                error: error.message,
              });
            }
          });
          break;
      }
    };

    function init(wasmBinary) {
      transcoderPending = new Promise((resolve) => {
        BasisModule = { wasmBinary, onRuntimeInitialized: resolve };
        BASIS(BasisModule); // eslint-disable-line no-undef
      }).then(() => {
        BasisModule.initializeBasis();
      });
    }

    function transcodeLowLevel(taskConfig) {
      var { basisFormat, width, height, hasAlpha } = taskConfig;

      var { transcoderFormat, engineFormat } = getTranscoderFormat(
        basisFormat,
        width,
        height,
        hasAlpha
      );

      var blockByteLength = BasisModule.getBytesPerBlockOrPixel(
        transcoderFormat
      );

      assert(
        BasisModule.isFormatSupported(transcoderFormat),
        "THREE.BasisTextureLoader: Unsupported format."
      );

      var mipmaps = [];

      if (basisFormat === BasisFormat.ETC1S) {
        var transcoder = new BasisModule.LowLevelETC1SImageTranscoder();

        var {
          endpointCount,
          endpointsData,
          selectorCount,
          selectorsData,
          tablesData,
        } = taskConfig.globalData;

        try {
          var ok;

          ok = transcoder.decodePalettes(
            endpointCount,
            endpointsData,
            selectorCount,
            selectorsData
          );

          assert(ok, "THREE.BasisTextureLoader: decodePalettes() failed.");

          ok = transcoder.decodeTables(tablesData);

          assert(ok, "THREE.BasisTextureLoader: decodeTables() failed.");

          for (var i = 0; i < taskConfig.levels.length; i++) {
            var level = taskConfig.levels[i];
            var imageDesc = taskConfig.globalData.imageDescs[i];

            var dstByteLength = getTranscodedImageByteLength(
              transcoderFormat,
              level.width,
              level.height
            );
            var dst = new Uint8Array(dstByteLength);

            ok = transcoder.transcodeImage(
              transcoderFormat,
              dst,
              dstByteLength / blockByteLength,
              level.data,
              getWidthInBlocks(transcoderFormat, level.width),
              getHeightInBlocks(transcoderFormat, level.height),
              level.width,
              level.height,
              level.index,
              imageDesc.rgbSliceByteOffset,
              imageDesc.rgbSliceByteLength,
              imageDesc.alphaSliceByteOffset,
              imageDesc.alphaSliceByteLength,
              imageDesc.imageFlags,
              hasAlpha,
              false,
              0,
              0
            );

            assert(
              ok,
              "THREE.BasisTextureLoader: transcodeImage() failed for level " +
                level.index +
                "."
            );

            mipmaps.push({
              data: dst,
              width: level.width,
              height: level.height,
            });
          }
        } finally {
          transcoder.delete();
        }
      } else {
        for (var i = 0; i < taskConfig.levels.length; i++) {
          var level = taskConfig.levels[i];

          var dstByteLength = getTranscodedImageByteLength(
            transcoderFormat,
            level.width,
            level.height
          );
          var dst = new Uint8Array(dstByteLength);

          var ok = BasisModule.transcodeUASTCImage(
            transcoderFormat,
            dst,
            dstByteLength / blockByteLength,
            level.data,
            getWidthInBlocks(transcoderFormat, level.width),
            getHeightInBlocks(transcoderFormat, level.height),
            level.width,
            level.height,
            level.index,
            0,
            level.data.byteLength,
            0,
            hasAlpha,
            false,
            0,
            0,
            -1,
            -1
          );

          assert(
            ok,
            "THREE.BasisTextureLoader: transcodeUASTCImage() failed for level " +
              level.index +
              "."
          );

          mipmaps.push({ data: dst, width: level.width, height: level.height });
        }
      }

      return { width, height, hasAlpha, mipmaps, format: engineFormat };
    }

    function transcode(buffer) {
      var basisFile = new BasisModule.BasisFile(new Uint8Array(buffer));

      var basisFormat = basisFile.isUASTC()
        ? BasisFormat.UASTC_4x4
        : BasisFormat.ETC1S;
      var width = basisFile.getImageWidth(0, 0);
      var height = basisFile.getImageHeight(0, 0);
      var levels = basisFile.getNumLevels(0);
      var hasAlpha = basisFile.getHasAlpha();

      function cleanup() {
        basisFile.close();
        basisFile.delete();
      }

      var { transcoderFormat, engineFormat } = getTranscoderFormat(
        basisFormat,
        width,
        height,
        hasAlpha
      );

      if (!width || !height || !levels) {
        cleanup();
        throw new Error("THREE.BasisTextureLoader:	Invalid texture");
      }

      if (!basisFile.startTranscoding()) {
        cleanup();
        throw new Error("THREE.BasisTextureLoader: .startTranscoding failed");
      }

      var mipmaps = [];

      for (var mip = 0; mip < levels; mip++) {
        var mipWidth = basisFile.getImageWidth(0, mip);
        var mipHeight = basisFile.getImageHeight(0, mip);
        var dst = new Uint8Array(
          basisFile.getImageTranscodedSizeInBytes(0, mip, transcoderFormat)
        );

        var status = basisFile.transcodeImage(
          dst,
          0,
          mip,
          transcoderFormat,
          0,
          hasAlpha
        );

        if (!status) {
          cleanup();
          throw new Error("THREE.BasisTextureLoader: .transcodeImage failed.");
        }

        mipmaps.push({ data: dst, width: mipWidth, height: mipHeight });
      }

      cleanup();

      return { width, height, hasAlpha, mipmaps, format: engineFormat };
    }

    //

    // Optimal choice of a transcoder target format depends on the Basis format (ETC1S or UASTC),
    // device capabilities, and texture dimensions. The list below ranks the formats separately
    // for ETC1S and UASTC.
    //
    // In some cases, transcoding UASTC to RGBA32 might be preferred for higher quality (at
    // significant memory cost) compared to ETC1/2, BC1/3, and PVRTC. The transcoder currently
    // chooses RGBA32 only as a last resort and does not expose that option to the caller.
    var FORMAT_OPTIONS = [
      {
        if: "astcSupported",
        basisFormat: [this.BasisFormat.UASTC_4x4],
        transcoderFormat: [
          this.TranscoderFormat.ASTC_4x4,
          this.TranscoderFormat.ASTC_4x4,
        ],
        engineFormat: [
          this.EngineFormat.RGBA_ASTC_4x4_Format,
          this.EngineFormat.RGBA_ASTC_4x4_Format,
        ],
        priorityETC1S: Infinity,
        priorityUASTC: 1,
        needsPowerOfTwo: false,
      },
      {
        if: "bptcSupported",
        basisFormat: [this.BasisFormat.ETC1S, this.BasisFormat.UASTC_4x4],
        transcoderFormat: [
          this.TranscoderFormat.BC7_M5,
          this.TranscoderFormat.BC7_M5,
        ],
        engineFormat: [
          this.EngineFormat.RGBA_BPTC_Format,
          this.EngineFormat.RGBA_BPTC_Format,
        ],
        priorityETC1S: 3,
        priorityUASTC: 2,
        needsPowerOfTwo: false,
      },
      {
        if: "dxtSupported",
        basisFormat: [this.BasisFormat.ETC1S, this.BasisFormat.UASTC_4x4],
        transcoderFormat: [
          this.TranscoderFormat.BC1,
          this.TranscoderFormat.BC3,
        ],
        engineFormat: [
          this.EngineFormat.RGB_S3TC_DXT1_Format,
          this.EngineFormat.RGBA_S3TC_DXT5_Format,
        ],
        priorityETC1S: 4,
        priorityUASTC: 5,
        needsPowerOfTwo: false,
      },
      {
        if: "etc2Supported",
        basisFormat: [this.BasisFormat.ETC1S, this.BasisFormat.UASTC_4x4],
        transcoderFormat: [
          this.TranscoderFormat.ETC1,
          this.TranscoderFormat.ETC2,
        ],
        engineFormat: [
          this.EngineFormat.RGB_ETC2_Format,
          this.EngineFormat.RGBA_ETC2_EAC_Format,
        ],
        priorityETC1S: 1,
        priorityUASTC: 3,
        needsPowerOfTwo: false,
      },
      {
        if: "etc1Supported",
        basisFormat: [this.BasisFormat.ETC1S, this.BasisFormat.UASTC_4x4],
        transcoderFormat: [
          this.TranscoderFormat.ETC1,
          this.TranscoderFormat.ETC1,
        ],
        engineFormat: [
          this.EngineFormat.RGB_ETC1_Format,
          this.EngineFormat.RGB_ETC1_Format,
        ],
        priorityETC1S: 2,
        priorityUASTC: 4,
        needsPowerOfTwo: false,
      },
      {
        if: "pvrtcSupported",
        basisFormat: [this.BasisFormat.ETC1S, this.BasisFormat.UASTC_4x4],
        transcoderFormat: [
          this.TranscoderFormat.PVRTC1_4_RGB,
          this.TranscoderFormat.PVRTC1_4_RGBA,
        ],
        engineFormat: [
          this.EngineFormat.RGB_PVRTC_4BPPV1_Format,
          this.EngineFormat.RGBA_PVRTC_4BPPV1_Format,
        ],
        priorityETC1S: 5,
        priorityUASTC: 6,
        needsPowerOfTwo: true,
      },
    ];

    var ETC1S_OPTIONS = FORMAT_OPTIONS.sort(function (a, b) {
      return a.priorityETC1S - b.priorityETC1S;
    });
    var UASTC_OPTIONS = FORMAT_OPTIONS.sort(function (a, b) {
      return a.priorityUASTC - b.priorityUASTC;
    });

    function getTranscoderFormat(basisFormat, width, height, hasAlpha) {
      var transcoderFormat;
      var engineFormat;

      var options =
        basisFormat === BasisFormat.ETC1S ? ETC1S_OPTIONS : UASTC_OPTIONS;

      for (var i = 0; i < options.length; i++) {
        var opt = options[i];

        if (!config[opt.if]) continue;
        if (!opt.basisFormat.includes(basisFormat)) continue;
        if (
          opt.needsPowerOfTwo &&
          !(isPowerOfTwo(width) && isPowerOfTwo(height))
        )
          continue;

        transcoderFormat = opt.transcoderFormat[hasAlpha ? 1 : 0];
        engineFormat = opt.engineFormat[hasAlpha ? 1 : 0];

        return { transcoderFormat, engineFormat };
      }

      console.warn(
        "THREE.BasisTextureLoader: No suitable compressed texture format found. Decoding to RGBA32."
      );

      transcoderFormat = TranscoderFormat.RGBA32;
      engineFormat = EngineFormat.RGBAFormat;

      return { transcoderFormat, engineFormat };
    }

    function assert(ok, message) {
      if (!ok) throw new Error(message);
    }

    function getWidthInBlocks(transcoderFormat, width) {
      return Math.ceil(
        width / BasisModule.getFormatBlockWidth(transcoderFormat)
      );
    }

    function getHeightInBlocks(transcoderFormat, height) {
      return Math.ceil(
        height / BasisModule.getFormatBlockHeight(transcoderFormat)
      );
    }

    function getTranscodedImageByteLength(transcoderFormat, width, height) {
      var blockByteLength = BasisModule.getBytesPerBlockOrPixel(
        transcoderFormat
      );

      if (BasisModule.formatIsUncompressed(transcoderFormat)) {
        return width * height * blockByteLength;
      }

      if (
        transcoderFormat === TranscoderFormat.PVRTC1_4_RGB ||
        transcoderFormat === TranscoderFormat.PVRTC1_4_RGBA
      ) {
        // GL requires extra padding for very small textures:
        // https://www.khronos.org/registry/OpenGL/extensions/IMG/IMG_texture_compression_pvrtc.txt
        var paddedWidth = (width + 3) & ~3;
        var paddedHeight = (height + 3) & ~3;

        return (
          (Math.max(8, paddedWidth) * Math.max(8, paddedHeight) * 4 + 7) / 8
        );
      }

      return (
        getWidthInBlocks(transcoderFormat, width) *
        getHeightInBlocks(transcoderFormat, height) *
        blockByteLength
      );
    }

    function isPowerOfTwo(value) {
      if (value <= 2) return true;

      return (value & (value - 1)) === 0 && value !== 0;
    }
  }
}
