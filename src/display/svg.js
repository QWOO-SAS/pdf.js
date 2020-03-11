/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals __non_webpack_require__ */

import {
  createObjectURL, FONT_IDENTITY_MATRIX, IDENTITY_MATRIX, ImageKind, isNodeJS,
  isNum, OPS, Util, warn
} from '../shared/util';
import { DOMSVGFactory } from './dom_utils';

var SVGGraphics = function() {
  throw new Error('Not implemented: SVGGraphics');
};

if (typeof PDFJSDev === 'undefined' ||
    PDFJSDev.test('GENERIC || SINGLE_FILE')) {

var SVG_DEFAULTS = {
  fontStyle: 'normal',
  fontWeight: 'normal',
  fillColor: '#000000',
};

var convertImgData = (function convertImgDataClosure() {
  var PNG_HEADER =
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  var CHUNK_WRAPPER_SIZE = 12;

  var crcTable = new Int32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i;
    for (var h = 0; h < 8; h++) {
      if (c & 1) {
        c = 0xedB88320 ^ ((c >> 1) & 0x7fffffff);
      } else {
        c = (c >> 1) & 0x7fffffff;
      }
    }
    crcTable[i] = c;
  }

  function crc32(data, start, end) {
    var crc = -1;
    for (var i = start; i < end; i++) {
      var a = (crc ^ data[i]) & 0xff;
      var b = crcTable[a];
      crc = (crc >>> 8) ^ b;
    }
    return crc ^ -1;
  }

  function writePngChunk(type, body, data, offset) {
    var p = offset;
    var len = body.length;

    data[p] = len >> 24 & 0xff;
    data[p + 1] = len >> 16 & 0xff;
    data[p + 2] = len >> 8 & 0xff;
    data[p + 3] = len & 0xff;
    p += 4;

    data[p] = type.charCodeAt(0) & 0xff;
    data[p + 1] = type.charCodeAt(1) & 0xff;
    data[p + 2] = type.charCodeAt(2) & 0xff;
    data[p + 3] = type.charCodeAt(3) & 0xff;
    p += 4;

    data.set(body, p);
    p += body.length;

    var crc = crc32(data, offset + 4, p);

    data[p] = crc >> 24 & 0xff;
    data[p + 1] = crc >> 16 & 0xff;
    data[p + 2] = crc >> 8 & 0xff;
    data[p + 3] = crc & 0xff;
  }

  function adler32(data, start, end) {
    var a = 1;
    var b = 0;
    for (var i = start; i < end; ++i) {
      a = (a + (data[i] & 0xff)) % 65521;
      b = (b + a) % 65521;
    }
    return (b << 16) | a;
  }

  /**
   * @param {Uint8Array} literals The input data.
   * @returns {Uint8Array} The DEFLATE-compressed data stream in zlib format.
   *   This is the required format for compressed streams in the PNG format:
   *   http://www.libpng.org/pub/png/spec/1.2/PNG-Compression.html
   */
  function deflateSync(literals) {
    if (!isNodeJS()) {
      // zlib is certainly not available outside of Node.js. We can either use
      // the pako library for client-side DEFLATE compression, or use the canvas
      // API of the browser to obtain a more optimal PNG file.
      return deflateSyncUncompressed(literals);
    }
    try {
      // NOTE: This implementation is far from perfect, but already way better
      // than not applying any compression.
      //
      // A better algorithm will try to choose a good predictor/filter and
      // then choose a suitable zlib compression strategy (e.g. 3,Z_RLE).
      //
      // Node v0.11.12 zlib.deflateSync is introduced (and returns a Buffer).
      // Node v3.0.0   Buffer inherits from Uint8Array.
      // Node v8.0.0   zlib.deflateSync accepts Uint8Array as input.
      var input;
        // eslint-disable-next-line no-undef
      if (parseInt(process.versions.node) >= 8) {
        input = literals;
      } else {
        // eslint-disable-next-line no-undef
        input = new Buffer(literals);
      }
      var output = __non_webpack_require__('zlib')
        .deflateSync(input, { level: 9, });
      return output instanceof Uint8Array ? output : new Uint8Array(output);
    } catch (e) {
      warn('Not compressing PNG because zlib.deflateSync is unavailable: ' + e);
    }

    return deflateSyncUncompressed(literals);
  }

  // An implementation of DEFLATE with compression level 0 (Z_NO_COMPRESSION).
  function deflateSyncUncompressed(literals) {
    var len = literals.length;
    var maxBlockLength = 0xFFFF;

    var deflateBlocks = Math.ceil(len / maxBlockLength);
    var idat = new Uint8Array(2 + len + deflateBlocks * 5 + 4);
    var pi = 0;
    idat[pi++] = 0x78; // compression method and flags
    idat[pi++] = 0x9c; // flags

    var pos = 0;
    while (len > maxBlockLength) {
      // writing non-final DEFLATE blocks type 0 and length of 65535
      idat[pi++] = 0x00;
      idat[pi++] = 0xff;
      idat[pi++] = 0xff;
      idat[pi++] = 0x00;
      idat[pi++] = 0x00;
      idat.set(literals.subarray(pos, pos + maxBlockLength), pi);
      pi += maxBlockLength;
      pos += maxBlockLength;
      len -= maxBlockLength;
    }

    // writing non-final DEFLATE blocks type 0
    idat[pi++] = 0x01;
    idat[pi++] = len & 0xff;
    idat[pi++] = len >> 8 & 0xff;
    idat[pi++] = (~len & 0xffff) & 0xff;
    idat[pi++] = (~len & 0xffff) >> 8 & 0xff;
    idat.set(literals.subarray(pos), pi);
    pi += literals.length - pos;

    var adler = adler32(literals, 0, literals.length); // checksum
    idat[pi++] = adler >> 24 & 0xff;
    idat[pi++] = adler >> 16 & 0xff;
    idat[pi++] = adler >> 8 & 0xff;
    idat[pi++] = adler & 0xff;
    return idat;
  }

  function encodePng(imgData, kind, isMask) {
    var width = imgData.width;
    var height = imgData.height;
    var bitDepth, colorType, lineSize;
    var bytes = imgData.data;

    switch (kind) {
      case ImageKind.GRAYSCALE_1BPP:
        colorType = 0;
        bitDepth = 1;
        lineSize = (width + 7) >> 3;
        break;
      case ImageKind.RGB_24BPP:
        colorType = 2;
        bitDepth = 8;
        lineSize = width * 3;
        break;
      case ImageKind.RGBA_32BPP:
        colorType = 6;
        bitDepth = 8;
        lineSize = width * 4;
        break;
      default:
        throw new Error('invalid format');
    }

    // prefix every row with predictor 0
    var literals = new Uint8Array((1 + lineSize) * height);
    var offsetLiterals = 0, offsetBytes = 0;
    var y, i;
    for (y = 0; y < height; ++y) {
      literals[offsetLiterals++] = 0; // no prediction
      literals.set(bytes.subarray(offsetBytes, offsetBytes + lineSize),
                   offsetLiterals);
      offsetBytes += lineSize;
      offsetLiterals += lineSize;
    }

    if (kind === ImageKind.GRAYSCALE_1BPP && isMask) {
      // inverting for B/W
      offsetLiterals = 0;
      for (y = 0; y < height; y++) {
        offsetLiterals++; // skipping predictor
        for (i = 0; i < lineSize; i++) {
          literals[offsetLiterals++] ^= 0xFF;
        }
      }
    }

    var ihdr = new Uint8Array([
      width >> 24 & 0xff,
      width >> 16 & 0xff,
      width >> 8 & 0xff,
      width & 0xff,
      height >> 24 & 0xff,
      height >> 16 & 0xff,
      height >> 8 & 0xff,
      height & 0xff,
      bitDepth, // bit depth
      colorType, // color type
      0x00, // compression method
      0x00, // filter method
      0x00 // interlace method
    ]);

    var idat = deflateSync(literals);

    // PNG will consists: header, IHDR+data, IDAT+data, and IEND.
    var pngLength = PNG_HEADER.length + (CHUNK_WRAPPER_SIZE * 3) +
                    ihdr.length + idat.length;
    var data = new Uint8Array(pngLength);
    var offset = 0;
    data.set(PNG_HEADER, offset);
    offset += PNG_HEADER.length;
    writePngChunk('IHDR', ihdr, data, offset);
    offset += CHUNK_WRAPPER_SIZE + ihdr.length;
    writePngChunk('IDATA', idat, data, offset);
    offset += CHUNK_WRAPPER_SIZE + idat.length;
    writePngChunk('IEND', new Uint8Array(0), data, offset);

    return createObjectURL(data, 'image/png', true);
  }

  function encodeBmp(imgData, kind, isMask){
    function writeWord(buffer, value, offset) {
      for (var i = 0; i < 4; i++) {
        buffer[offset + i] = (value >> (8*i)) & 255;
      }
    }
    var width = imgData.width;
    var height = imgData.height;
    var lineSize;
    var bytes = imgData.data;
    var dataOffset = 122;
    var bmpData, dataSize, totalSize;
    switch(kind){
      case ImageKind.GRAYSCALE_1BPP:
        var lineSizeOut = lineSize = (width + 7) >> 3;
        for (; lineSizeOut&3; lineSizeOut++){}
        dataOffset += 8;
        dataSize = lineSizeOut * height;
        totalSize = dataOffset + dataSize;
        bmpData = new Uint8Array(totalSize);
        bmpData[28] = 1;
        bmpData[106] = 2;
        bmpData.set([0x42, 0x47, 0x52, 0x73], 54);
        bmpData[126 - 4 * isMask] = bmpData[127 - 4 * isMask] = 
                                    bmpData[128 - 4 * isMask] = 255;
        for (var y = 0; y < height; y++) {
          bmpData.set(bytes.subarray(y * lineSize, (y + 1) * lineSize),
                      dataOffset + lineSizeOut * (height - y - 1));
        }
        break;
      case ImageKind.RGB_24BPP:
        var lineSizeOut = lineSize = width * 3;
        for (; lineSizeOut&3; lineSizeOut++){}
        dataSize = lineSizeOut * height;
        totalSize = dataOffset + dataSize;
        bmpData = new Uint8Array(totalSize);
        bmpData[28] = 24;
        bmpData.set([0x42, 0x47, 0x52, 0x73], 70);
        for (var y = 0; y < height; y++) {
          var line = new Uint8Array(bytes.subarray(y * lineSize,
                                                   (y + 1) * lineSize));
          for (var x = 0, v = 0, n = 0; x < width; x++, n+=3) {
            v = line[n];
            line[n] = line[n+2];
            line[n+2] = v;
          }
          bmpData.set(line, dataOffset + lineSizeOut * (height - y - 1));
        }
        break;
      case ImageKind.RGBA_32BPP:
        lineSize = width * 4;
        dataSize = lineSize * height;
        totalSize = dataOffset + dataSize;
        bmpData = new Uint8Array(totalSize);
        bmpData[28] = 32;
        bmpData[30] = 3;
        bmpData[54] = bmpData[59] = bmpData[64] = bmpData[69] = 255;
        bmpData.set([0x42, 0x47, 0x52, 0x73], 70);
        for (var y = 0; y < height; y++)
          bmpData.set(bytes.subarray(y * lineSize, (y + 1) * lineSize),
                      dataOffset + lineSize * (height - y - 1));
        break;
      default:
        throw new Error('invalid format');
    }
    bmpData.set([0x42, 0x4d]);
    writeWord(bmpData, totalSize, 2);
    bmpData[10] = dataOffset;
    bmpData[14] = 108;
    writeWord(bmpData, width, 18);
    writeWord(bmpData, height, 22);
    bmpData[26] = 1;
    writeWord(bmpData, dataSize, 34);
    bmpData.set([0x13, 0xb], 38);
    bmpData.set([0x13, 0xb], 42);

    return createObjectURL(bmpData, 'image/bmp');
  };

  return function convertImgData(imgData, forceDataSchema, isMask) {
    var kind = (imgData.kind === undefined ?
                ImageKind.GRAYSCALE_1BPP : imgData.kind);
    return forceDataSchema ? encodePng(imgData, kind, isMask) : 
                             encodeBmp(imgData, kind, isMask);
  };
})();

var SVGExtraState = (function SVGExtraStateClosure() {
  function SVGExtraState() {
    this.fontSizeScale = 1;
    this.fontWeight = SVG_DEFAULTS.fontWeight;
    this.fontSize = 0;

    this.textMatrix = IDENTITY_MATRIX;
    this.fontMatrix = FONT_IDENTITY_MATRIX;
    this.leading = 0;

    // Current point (in user coordinates)
    this.x = 0;
    this.y = 0;

    // Start of text line (in text coordinates)
    this.lineX = 0;
    this.lineY = 0;

    // Character and word spacing
    this.charSpacing = 0;
    this.wordSpacing = 0;
    this.textHScale = 1;
    this.textRise = 0;

    // Default foreground and background colors
    this.fillColor = SVG_DEFAULTS.fillColor;
    this.strokeColor = '#000000';

    this.fillAlpha = 1;
    this.pattern = '';
    this.strokeAlpha = 1;
    this.blendMode = 'source-over';
    this.lineWidth = 1;
    this.lineJoin = '';
    this.lineCap = '';
    this.miterLimit = 0;

    this.dashArray = [];
    this.dashPhase = 0;

    this.dependencies = [];
    this.activeGradientUrl = null;
    this.fillPatternId = '';
    this.strokePatternId = '';
    this.group = null;
    this.parentGroup = null;
    this.maskedGroup = null;
  }

  SVGExtraState.prototype = {
    clone: function SVGExtraState_clone() {
      return Object.create(this);
    },
    setCurrentPoint: function SVGExtraState_setCurrentPoint(x, y) {
      this.x = x;
      this.y = y;
    },
  };
  return SVGExtraState;
})();

SVGGraphics = (function SVGGraphicsClosure() {
  function opListToTree(opList) {
    var opTree = [];
    var tmp = [];
    var opListLen = opList.length;

    for (var x = 0; x < opListLen; x++) {
      if (opList[x].fn === 'save') {
        opTree.push({ 'fnId': 92, 'fn': 'group', 'items': [], });
        tmp.push(opTree);
        opTree = opTree[opTree.length - 1].items;
        continue;
      }

      if (opList[x].fn === 'restore') {
        opTree = tmp.pop();
      } else {
        opTree.push(opList[x]);
      }
    }
    return opTree;
  }

  /**
   * Formats float number.
   * @param value {number} number to format.
   * @returns {string}
   */
  function pf(value) {
    if (Number.isInteger(value)) {
      return value.toString();
    }
    var s = value.toFixed(10);
    var i = s.length - 1;
    if (s[i] !== '0') {
      return s;
    }
    // removing trailing zeros
    do {
      i--;
    } while (s[i] === '0');
    return s.substr(0, s[i] === '.' ? i : i + 1);
  }

  /**
   * Formats transform matrix. The standard rotation, scale and translate
   * matrices are replaced by their shorter forms, and for identity matrix
   * returns empty string to save the memory.
   * @param m {Array} matrix to format.
   * @returns {string}
   */
  function pm(m) {
    if (!m)
      return '';
    if (m[4] === 0 && m[5] === 0) {
      if (m[1] === 0 && m[2] === 0) {
        if (m[0] === 1 && m[3] === 1) {
          return '';
        }
        return 'scale(' + pf(m[0]) + ' ' + pf(m[3]) + ')';
      }
      if (m[0] === m[3] && m[1] === -m[2]) {
        var a = Math.acos(m[0]) * 180 / Math.PI;
        return 'rotate(' + pf(a) + ')';
      }
    } else {
      if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1) {
        return 'translate(' + pf(m[4]) + ' ' + pf(m[5]) + ')';
      }
    }
    return 'matrix(' + pf(m[0]) + ' ' + pf(m[1]) + ' ' + pf(m[2]) + ' ' +
      pf(m[3]) + ' ' + pf(m[4]) + ' ' + pf(m[5]) + ')';
  }

  function SVGGraphics(commonObjs, objs, forceDataSchema) {
    this.svgFactory = new DOMSVGFactory();

    this.current = new SVGExtraState();
    this.transformMatrix = IDENTITY_MATRIX; // Graphics state matrix
    this.extraStack = [];
    this.commonObjs = commonObjs;
    this.objs = objs;
    this.pendingClip = null;
    this.pendingEOFill = false;

    this.embedFonts = false;
    this.embeddedFonts = Object.create(null);
    this.cssStyle = null;
    this.group = null;
    this.forceDataSchema = !!forceDataSchema;
  }

  var XML_NS = 'http://www.w3.org/XML/1998/namespace';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var LINE_CAP_STYLES = ['butt', 'round', 'square'];
  var LINE_JOIN_STYLES = ['miter', 'round', 'bevel'];
  var clipCount = 0;
  var maskCount = 0;
  var gradientCount = 0;
  var patternCount = 0;

  SVGGraphics.prototype = {
    save: function SVGGraphics_save() {
      var old = this.current;
      old.parentGroup = this.parentGroup;
      old.group = this.group;
      this.extraStack.push(old);
      this.current = old.clone();
      this.current.fillPatternId = '';
      this.current.strokePatternId = '';
      this.current.activeGradientUrl = null;
    },

    restore: function SVGGraphics_restore() {
      this.current = this.extraStack.pop();

      this.pendingClip = null;
      this.group = this.current.group;
      this.parentGroup = this.current.parentGroup;
    },
    createGroup: function SVGGraphics_group(items) {
      this.save();
      this.parentGroup = this.group;
      this.group = this.svgFactory.createElement('g');
      this.parentGroup.appendChild(this.group);
      this.executeOpTree(items);
      var url = this.current.activeGradientUrl;
      if (url) {
        var blendMode = this.current.blendMode;
        this.parentGroup.removeChild(this.group);
        var parentGroup = this.parentGroup;
        this.restore();
        var path = this.current.path.cloneNode();
        path.setAttributeNS(null, 'fill', url);
        if (blendMode != 'source-over')
          path.setAttributeNS(null, 'style', 'mix-blend-mode: ' + blendMode);
        parentGroup.appendChild(path);
      }
      else {
        if (!this.group.children.length)
          this.parentGroup.removeChild(this.group);
        this.restore();
      }
    },

    loadDependencies: function SVGGraphics_loadDependencies(operatorList) {
      var fnArray = operatorList.fnArray;
      var fnArrayLen = fnArray.length;
      var argsArray = operatorList.argsArray;

      for (var i = 0; i < fnArrayLen; i++) {
        if (OPS.dependency === fnArray[i]) {
          var deps = argsArray[i];
          for (var n = 0, nn = deps.length; n < nn; n++) {
            var obj = deps[n];
            var common = obj.substring(0, 2) === 'g_';
            var promise;
            if (common) {
              promise = new Promise((resolve) => {
                this.commonObjs.get(obj, resolve);
              });
            } else {
              promise = new Promise((resolve) => {
                this.objs.get(obj, resolve);
              });
            }
            this.current.dependencies.push(promise);
          }
        }
      }
      return Promise.all(this.current.dependencies);
    },

    transform: function SVGGraphics_transform(a, b, c, d, e, f) {
      this.transformMatrix = [a, b, c, d, e, f];
      this.parentGroup = this.group;
      this.group = this.svgFactory.createElement('g');
      this.group.setAttributeNS(null, 'transform',
                                pm(this.transformMatrix));
      this.parentGroup.appendChild(this.group);
    },

    getSVG: function SVGGraphics_getSVG(operatorList, viewport) {
      this.viewport = viewport;

      var svgElement = this._initialize(viewport);
      return this.loadDependencies(operatorList).then(() => {
        this.transformMatrix = IDENTITY_MATRIX;
        var opTree = this.convertOpList(operatorList);
        this.executeOpTree(opTree);
        return svgElement;
      });
    },

    convertOpList: function SVGGraphics_convertOpList(operatorList) {
      var argsArray = operatorList.argsArray;
      var fnArray = operatorList.fnArray;
      var fnArrayLen = fnArray.length;
      var REVOPS = [];
      var opList = [];

      for (var op in OPS) {
        REVOPS[OPS[op]] = op;
      }

      for (var x = 0; x < fnArrayLen; x++) {
        var fnId = fnArray[x];
        opList.push({
          'fnId': fnId,
          'fn': REVOPS[fnId],
          'args': argsArray[x],
        });
      }
      return opListToTree(opList);
    },

    executeOpTree: function SVGGraphics_executeOpTree(opTree) {
      var opTreeLen = opTree.length;
      for (var x = 0; x < opTreeLen; x++) {
        var fn = opTree[x].fn;
        var fnId = opTree[x].fnId;
        var args = opTree[x].args;

        switch (fnId | 0) {
          case OPS.beginText:
            this.beginText();
            break;
          case OPS.setLeading:
            this.setLeading(args);
            break;
          case OPS.setLeadingMoveText:
            this.setLeadingMoveText(args[0], args[1]);
            break;
          case OPS.setFont:
            this.setFont(args);
            break;
          case OPS.showText:
            this.showText(args[0]);
            break;
          case OPS.showSpacedText:
            this.showText(args[0]);
            break;
          case OPS.endText:
            this.endText();
            break;
          case OPS.moveText:
            this.moveText(args[0], args[1]);
            break;
          case OPS.setCharSpacing:
            this.setCharSpacing(args[0]);
            break;
          case OPS.setWordSpacing:
            this.setWordSpacing(args[0]);
            break;
          case OPS.setHScale:
            this.setHScale(args[0]);
            break;
          case OPS.setTextMatrix:
            this.setTextMatrix(args[0], args[1], args[2],
                               args[3], args[4], args[5]);
            break;
          case OPS.setTextRise:
            this.setTextRise(args[0]);
            break;
          case OPS.setLineWidth:
            this.setLineWidth(args[0]);
            break;
          case OPS.setLineJoin:
            this.setLineJoin(args[0]);
            break;
          case OPS.setLineCap:
            this.setLineCap(args[0]);
            break;
          case OPS.setMiterLimit:
            this.setMiterLimit(args[0]);
            break;
          case OPS.setFillRGBColor:
            this.setFillRGBColor(args[0], args[1], args[2]);
            break;
          case OPS.setStrokeRGBColor:
            this.setStrokeRGBColor(args[0], args[1], args[2]);
            break;
          case OPS.setDash:
            this.setDash(args[0], args[1]);
            break;
          case OPS.shadingFill:
            this.shadingFill(args[0]);
            break;
          case OPS.setGState:
            this.setGState(args[0]);
            break;
          case OPS.fill:
            this.fill();
            break;
          case OPS.eoFill:
            this.eoFill();
            break;
          case OPS.stroke:
            this.stroke();
            break;
          case OPS.fillStroke:
            this.fillStroke();
            break;
          case OPS.eoFillStroke:
            this.eoFillStroke();
            break;
          case OPS.clip:
            this.clip('nonzero');
            break;
          case OPS.eoClip:
            this.clip('evenodd');
            break;
          case OPS.paintSolidColorImageMask:
            this.paintSolidColorImageMask();
            break;
          case OPS.paintJpegXObject:
            this.paintJpegXObject(args[0], args[1], args[2]);
            break;
          case OPS.paintImageXObject:
            this.paintImageXObject(args[0]);
            break;
          case OPS.paintInlineImageXObject:
            this.paintInlineImageXObject(args[0]);
            break;
          case OPS.paintImageMaskXObject:
            this.paintImageMaskXObject(args[0]);
            break;
          case OPS.paintFormXObjectBegin:
            this.paintFormXObjectBegin(args[0], args[1]);
            break;
          case OPS.paintFormXObjectEnd:
            this.paintFormXObjectEnd();
            break;
          case OPS.closePath:
            this.closePath();
            break;
          case OPS.closeStroke:
            this.closeStroke();
            break;
          case OPS.closeFillStroke:
            this.closeFillStroke();
            break;
          case OPS.nextLine:
            this.nextLine();
            break;
          case OPS.transform:
            this.transform(args[0], args[1], args[2], args[3],
                           args[4], args[5]);
            break;
          case OPS.beginGroup:
            this.beginGroup(args[0]);
            break;
          case OPS.endGroup:
            this.endGroup(args[0]);
            break;
          case OPS.constructPath:
            this.constructPath(args[0], args[1]);
            break;
          case OPS.endPath:
            this.endPath();
            break;
          case OPS.group:
            this.createGroup(opTree[x].items);
            break;
          case OPS.setStrokeColorN:
            this.setStrokeColorN(args);
            break;
          case OPS.setFillColorN:
            this.setFillColorN(args);
            break;
          default:
            warn('Unimplemented operator ' + fn);
            break;
        }
      }
    },
    buildGradient: function SVGGraphics_buildGradient(args, matrix) { 
      var id = 'gradient' + (gradientCount++);
      var gradient = this.svgFactory.createElement(args[1] == 'axial' ? 'linearGradient' : 'radialGradient');
      gradient.setAttributeNS(null, 'id', id);
      if (matrix)
        gradient.setAttributeNS(null, 'gradientTransform', matrix);
      gradient.setAttributeNS(null, 'gradientUnits', "userSpaceOnUse");
      if (args[1] == 'axial') {
        if (args[3][0] != undefined)
          gradient.setAttributeNS(null, 'x1', args[3][0]);
        if (args[3][1] != undefined)
          gradient.setAttributeNS(null, 'y1', args[3][1]);
        if (args[4][0] != undefined)
          gradient.setAttributeNS(null, 'x2', args[4][0]);
        if (args[4][1] != undefined)
          gradient.setAttributeNS(null, 'y2', args[4][1]);
      }
      else if (args[1] == 'radial') {
        if (args[3][0] != undefined)
          gradient.setAttributeNS(null, 'fx', args[3][0]);
        if (args[3][1] != undefined)
          gradient.setAttributeNS(null, 'fy', args[3][1]);
        if (args[5] != undefined)
          gradient.setAttributeNS(null, 'fr', args[5]);
        if (args[3][0] != undefined)
          gradient.setAttributeNS(null, 'cx', args[4][0]);
        if (args[4][1] != undefined)
          gradient.setAttributeNS(null, 'cy', args[4][1]);
        if (args[6] != undefined)
          gradient.setAttributeNS(null, 'r', args[6]);
      }
      else
        return;
      this.defs.appendChild(gradient);
      for (var s of args[2]) {
        var stop = this.svgFactory.createElement('stop');
        if (s[0] != undefined)
          stop.setAttributeNS(null, 'offset', s[0]);
        if (s[1] != undefined)
          stop.setAttributeNS(null, 'stop-color', s[1]);
        gradient.append(stop);
      }
      return id;
    },
    buildPattern: function SVGGraphics_buildPattern(args) {
      var group = this.group;
      var defs = this.defs;
      var operatorList = args[2];
      var opTree = this.convertOpList(operatorList);
      var matrix = args[3] || [1, 0, 0, 1, 0, 0];
      var bbox = args[4];
      var xstep = args[5];
      var ystep = args[6];
      this.group = this.svgFactory.createElement('pattern');
      var id = this.group.id = "pattern" + (patternCount++);
      this.defs = this.svgFactory.createElement('defs');
      var matrix_text = pm(matrix);
      if (matrix_text)
        this.group.setAttributeNS(null, 'patternTransform', matrix_text);
      this.group.setAttributeNS(null, 'patternUnits', 'userSpaceOnUse');
      this.group.setAttributeNS(null, 'viewBox', bbox.join(','));
      this.group.setAttributeNS(null, 'width', (bbox[2] - bbox[0]));
      this.group.setAttributeNS(null, 'height', (bbox[3] - bbox[1]));
      this.executeOpTree(opTree);
      if (this.defs.childElementCount)
        this.group.appendChild(this.defs);
      this.defs = defs;
      this.defs.appendChild(this.group);
      this.group = group;
      return id;
    },
    invMatrix: function SVGGraphics_invMatrix(matrix) {
      var det = matrix[0] * matrix[3] - matrix[2] * matrix[1];
      return [matrix[3] / det, -matrix[1] / det, -matrix[2] / det, matrix[0] / det, (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / det, -(matrix[0] * matrix[5] - matrix[1] * matrix[4]) / det];
    },
    setFillColorN: function SVGGraphics_setFillColorN(args) {
      var current = this.current;
      var color = args[1];
      var paintType = args[7];
      if (args[0] == 'TilingPattern') {
        if (paintType == 2 && Array.isArray(color) && color.length == 3)
          current.fillColor = Util.makeCssRgb(color[0], color[1], color[2]);
        current.fillPatternId = this.buildPattern(args);
      }
      else if (args[0] == 'RadialAxial')
        current.fillColor = 'url(#' + this.buildGradient(args, pm(this.invMatrix(this.transformMatrix))) + ')';
      else {
        console.log('Unimplemented Filling type ' + args[0]);
      }
    },
    setStrokeColorN: function SVGGraphics_setStrokeColorN(args) {
      var current = this.current;
      var color = args[1];
      var paintType = args[7];
      if (args[0] == 'TilingPattern') {
        if (paintType == 2 && Array.isArray(color) && color.length == 3)
          current.strokeColor = Util.makeCssRgb(color[0], color[1], color[2]);
        current.strokePatternId = this.buildPattern(args);
      }
      else if (args[0] == 'RadialAxial')
        current.strokeColor = 'url(#' + this.buildGradient(args, pm(this.invMatrix(this.transformMatrix))) + ')';
      else {
        console.log('Unimplemented Stroking type ' + args[0]);
      }
    },
    setWordSpacing: function SVGGraphics_setWordSpacing(wordSpacing) {
      this.current.wordSpacing = wordSpacing;
    },

    setCharSpacing: function SVGGraphics_setCharSpacing(charSpacing) {
      this.current.charSpacing = charSpacing;
    },

    nextLine: function SVGGraphics_nextLine() {
      this.moveText(0, this.current.leading);
    },

    setTextMatrix: function SVGGraphics_setTextMatrix(a, b, c, d, e, f) {
      var current = this.current;

      this.current.textMatrix = [a, b, c, d, e, f];
      this.current.x = this.current.lineX = 0;
      this.current.y = this.current.lineY = 0;

      current.xcoords = [];
      current.tspan = this.svgFactory.createElement('svg:tspan');
      if (current.fontFamily)
        current.tspan.setAttributeNS(null, 'font-family', current.fontFamily);
      current.tspan.setAttributeNS(null, 'font-size',
                                   pf(current.fontSize) + 'px');
      current.tspan.setAttributeNS(null, 'y', pf(-current.y));

      current.txtElement = this.svgFactory.createElement('svg:text');
      current.txtElement.appendChild(current.tspan);
    },

    beginText: function SVGGraphics_beginText() {
      this.current.x = this.current.lineX = 0;
      this.current.y = this.current.lineY = 0;
      this.current.textMatrix = IDENTITY_MATRIX;
      this.current.tspan = this.svgFactory.createElement('svg:tspan');
      this.current.txtElement = this.svgFactory.createElement('svg:text');
      this.current.txtgrp = this.svgFactory.createElement('svg:g');
      this.current.element = this.current.txtgrp;
      this.current.xcoords = [];
    },

    moveText: function SVGGraphics_moveText(x, y) {
      var current = this.current;
      current.xcoords = [];
      current.x = current.lineX = 0;
      current.y = current.lineY = 0;
      let textMatrix = current.textMatrix.slice();
      textMatrix[4] += textMatrix[0] * x + textMatrix[2] * y;
      textMatrix[5] += textMatrix[1] * x + textMatrix[3] * y;
      current.textMatrix = textMatrix;
      current.txtElement = this.svgFactory.createElement('svg:text');
      current.tspan = this.svgFactory.createElement('svg:tspan');
      if (current.fontFamily)
        current.tspan.setAttributeNS(null, 'font-family', current.fontFamily);
      current.tspan.setAttributeNS(null, 'font-size',
                                   pf(current.fontSize) + 'px');
      current.tspan.setAttributeNS(null, 'y', pf(-current.y));
    },

    showText: function SVGGraphics_showText(glyphs) {
      var current = this.current;
      var font = current.font;
      var fontSize = current.fontSize;

      if (fontSize === 0) {
        return;
      }

      var charSpacing = current.charSpacing;
      var wordSpacing = current.wordSpacing;
      var fontDirection = current.fontDirection;
      var textHScale = current.textHScale * fontDirection;
      var glyphsLength = glyphs.length;
      var vertical = font.vertical;
      var widthAdvanceScale = fontSize * current.fontMatrix[0];

      var x = 0, i;
      for (i = 0; i < glyphsLength; ++i) {
        var glyph = glyphs[i];
        if (glyph === null) {
          // word break
          x += fontDirection * wordSpacing;
          continue;
        } else if (isNum(glyph)) {
          x += -glyph * fontSize * 0.001;
          continue;
        }

        var width = glyph.width;
        var character = glyph.fontChar;
        var spacing = (glyph.isSpace ? wordSpacing : 0) + charSpacing;
        var charWidth = width * widthAdvanceScale + spacing * fontDirection;

        if (!glyph.isInFont && !font.missingFile) {
          x += charWidth;
          // TODO: To assist with text selection, we should replace the missing
          // character with a space character if charWidth is not zero.
          // But we cannot just do "character = ' '", because the ' ' character
          // might actually map to a different glyph.
          continue;
        }
        current.xcoords.push(current.x + x * textHScale);
        current.tspan.textContent += character;
        x += charWidth;
      }
      if (vertical) {
        current.y -= x * textHScale;
      } else {
        current.x += x * textHScale;
      }

      current.tspan.setAttributeNS(null, 'x',
                                   current.xcoords.map(pf).join(' '));
      current.tspan.setAttributeNS(null, 'y', pf(-current.y));
      if (current.fontFamily)
        current.tspan.setAttributeNS(null, 'font-family', current.fontFamily);
      current.tspan.setAttributeNS(null, 'font-size',
                                   pf(current.fontSize) + 'px');
      if (current.fontStyle !== SVG_DEFAULTS.fontStyle) {
        current.tspan.setAttributeNS(null, 'font-style', current.fontStyle);
      }
      if (current.fontWeight !== SVG_DEFAULTS.fontWeight) {
        current.tspan.setAttributeNS(null, 'font-weight', current.fontWeight);
      }
      if (current.fillColor !== SVG_DEFAULTS.fillColor) {
        current.tspan.setAttributeNS(null, 'fill', current.fillColor);
      }

      // Include the text rise in the text matrix since the `pm` function
      // creates the SVG element's `translate` entry (work on a copy to avoid
      // altering the original text matrix).
      let textMatrix = current.textMatrix;
      if (current.textRise !== 0) {
        textMatrix = textMatrix.slice();
        textMatrix[5] += current.textRise;
      }

      let transform = pm(textMatrix);
      if (current.fontMatrix.join(' ') != FONT_IDENTITY_MATRIX.join(' ')) {
        let fontMatrix = current.fontMatrix.slice();
        fontMatrix.forEach(function(x, i){
          fontMatrix[i] = x * 1000;
        });
        transform += ' ' + pm(fontMatrix);
      }
      transform += ' scale(1, -1)';
      current.txtElement.setAttributeNS(null, 'transform', transform);
      current.txtElement.appendChild(current.tspan);
      current.txtgrp.appendChild(current.txtElement);
      this.group.appendChild(current.txtgrp);
    },

    setLeadingMoveText: function SVGGraphics_setLeadingMoveText(x, y) {
      this.setLeading(-y);
      this.moveText(x, y);
    },

    addFontStyle: function SVGGraphics_addFontStyle(fontObj) {
      if (!this.cssStyle) {
        this.cssStyle = this.svgFactory.createElement('svg:style');
        this.cssStyle.setAttributeNS(null, 'type', 'text/css');
        this.defs.appendChild(this.cssStyle);
      }

      var url = createObjectURL(fontObj.data, fontObj.mimetype,
                                this.forceDataSchema);
      this.cssStyle.textContent +=
        '@font-face { font-family: "' + fontObj.loadedName + '";' +
        ' src: url(' + url + '); }\n';
    },

    setFont: function SVGGraphics_setFont(details) {
      var current = this.current;
      var fontObj = this.commonObjs.get(details[0]);
      var size = details[1];
      this.current.font = fontObj;

      if (this.embedFonts && fontObj.data &&
          !this.embeddedFonts[fontObj.loadedName]) {
        this.addFontStyle(fontObj);
        this.embeddedFonts[fontObj.loadedName] = fontObj;
      }

      current.fontMatrix = (fontObj.fontMatrix ?
                            fontObj.fontMatrix : FONT_IDENTITY_MATRIX);

      var bold = fontObj.black ? (fontObj.bold ? 'bolder' : 'bold') :
                                 (fontObj.bold ? 'bold' : 'normal');
      var italic = fontObj.italic ? 'italic' : 'normal';

      if (size < 0) {
        size = -size;
        current.fontDirection = -1;
      } else {
        current.fontDirection = 1;
      }
      current.fontSize = size;
      current.fontFamily = fontObj.loadedName;
      current.fontWeight = bold;
      current.fontStyle = italic;

      current.tspan = this.svgFactory.createElement('svg:tspan');
      current.tspan.setAttributeNS(null, 'y', pf(-current.y));
      current.xcoords = [];
    },

    endText: function SVGGraphics_endText() {},

    // Path properties
    setLineWidth: function SVGGraphics_setLineWidth(width) {
      this.current.lineWidth = Math.max(0.5, width);
    },
    setLineCap: function SVGGraphics_setLineCap(style) {
      this.current.lineCap = LINE_CAP_STYLES[style];
    },
    setLineJoin: function SVGGraphics_setLineJoin(style) {
      this.current.lineJoin = LINE_JOIN_STYLES[style];
    },
    setMiterLimit: function SVGGraphics_setMiterLimit(limit) {
      this.current.miterLimit = limit;
    },
    setStrokeAlpha: function SVGGraphics_setStrokeAlpha(strokeAlpha) {
      this.current.strokeAlpha = strokeAlpha;
    },
    setStrokeRGBColor: function SVGGraphics_setStrokeRGBColor(r, g, b) {
      var color = Util.makeCssRgb(r, g, b);
      this.current.strokeColor = color;
    },
    setFillAlpha: function SVGGraphics_setFillAlpha(fillAlpha) {
      this.current.fillAlpha = fillAlpha;
    },
    setFillRGBColor: function SVGGraphics_setFillRGBColor(r, g, b) {
      var color = Util.makeCssRgb(r, g, b);
      this.current.fillColor = color;
      this.current.tspan = this.svgFactory.createElement('svg:tspan');
      this.current.xcoords = [];
    },
    setDash: function SVGGraphics_setDash(dashArray, dashPhase) {
      this.current.dashArray = dashArray;
      this.current.dashPhase = dashPhase;
    },
    shadingFill: function SVGGraphics_shadingFill(args) {
      switch(args[0]){
        case 'RadialAxial':
          var id = this.buildGradient(args, pm(this.transformMatrix));
          if (id)
            this.current.activeGradientUrl = 'url(#' + id + ')';
          break;
        case 'Mesh':
          break;
        case 'Dummy':
          break;
        default:
          throw new Error(`Unknown IR type: ${args[0]}`);
      }
    },
    constructPath: function SVGGraphics_constructPath(ops, args) {
      var current = this.current;
      var x = current.x, y = current.y;
      current.path = this.svgFactory.createElement('svg:path');
      var d = [];
      var opLength = ops.length;

      for (var i = 0, j = 0; i < opLength; i++) {
        switch (ops[i] | 0) {
          case OPS.rectangle:
            x = args[j++];
            y = args[j++];
            var width = args[j++];
            var height = args[j++];
            var xw = x + width;
            var yh = y + height;
            d.push('M', pf(x), pf(y), 'L', pf(xw), pf(y), 'L', pf(xw), pf(yh),
                   'L', pf(x), pf(yh), 'Z');
            break;
          case OPS.moveTo:
            x = args[j++];
            y = args[j++];
            d.push('M', pf(x), pf(y));
            break;
          case OPS.lineTo:
            if (!d.length)
              d.push('M', pf(current.x), pf(current.y));
            x = args[j++];
            y = args[j++];
            d.push('L', pf(x), pf(y));
            break;
          case OPS.curveTo:
            if (!d.length)
              d.push('M', pf(current.x), pf(current.y));
            x = args[j + 4];
            y = args[j + 5];
            d.push('C', pf(args[j]), pf(args[j + 1]), pf(args[j + 2]),
                   pf(args[j + 3]), pf(x), pf(y));
            j += 6;
            break;
          case OPS.curveTo2:
            if (!d.length)
              d.push('M', pf(current.x), pf(current.y));
            d.push('C', pf(x), pf(y), pf(args[j]), pf(args[j + 1]), pf(args[j + 2]), pf(args[j + 3]));
            x = args[j + 2];
            y = args[j + 3];
            j += 4;
            break;
          case OPS.curveTo3:
            if (!d.length)
              d.push('M', pf(current.x), pf(current.y));
            x = args[j + 2];
            y = args[j + 3];
            d.push('C', pf(args[j]), pf(args[j + 1]), pf(x), pf(y),
                   pf(x), pf(y));
            j += 4;
            break;
          case OPS.closePath:
            d.push('Z');
            break;
        }
      }
      current.path.setAttributeNS(null, 'd', d.join(' '));
      current.path.setAttributeNS(null, 'fill', 'none');
      this.group.appendChild(this.current.path);

      // Saving a reference in current.element so that it can be addressed
      // in 'fill' and 'stroke'
      current.element = current.path;
      current.setCurrentPoint(x, y);
    },

    endPath: function SVGGraphics_endPath() {
      if (!this.pendingClip) {
        return;
      }
      var current = this.current;
      // Add current path to clipping path
      var clipId = 'clip' + (clipCount++);
      var clipPath = this.svgFactory.createElement('svg:clipPath');
      clipPath.setAttributeNS(null, 'id', clipId);
      this.defs.appendChild(clipPath);
      if (this.pendingClip === 'evenodd') {
        current.element.setAttributeNS(null, 'clip-rule', 'evenodd');
      } else {
        current.element.setAttributeNS(null, 'clip-rule', 'nonzero');
      }
      this.pendingClip = null;
      clipPath.appendChild(current.element);
      this.parentGroup = this.group;
      this.group = this.svgFactory.createElement('g');
      this.parentGroup.appendChild(this.group);
      this.group.setAttribute('clip-path', 'url(#' + clipId + ')');
    },

    clip: function SVGGraphics_clip(type) {
      this.pendingClip = type;
    },

    closePath: function SVGGraphics_closePath() {
      var current = this.current;
      var d = current.path.getAttributeNS(null, 'd');
      d += 'Z';
      current.path.setAttributeNS(null, 'd', d);
    },

    setLeading: function SVGGraphics_setLeading(leading) {
      this.current.leading = -leading;
    },

    setTextRise: function SVGGraphics_setTextRise(textRise) {
      this.current.textRise = textRise;
    },

    setHScale: function SVGGraphics_setHScale(scale) {
      this.current.textHScale = scale / 100;
    },

    setGState: function SVGGraphics_setGState(states) {
      for (var i = 0, ii = states.length; i < ii; i++) {
        var state = states[i];
        var key = state[0];
        var value = state[1];

        switch (key) {
          case 'LW':
            this.setLineWidth(value);
            break;
          case 'LC':
            this.setLineCap(value);
            break;
          case 'LJ':
            this.setLineJoin(value);
            break;
          case 'ML':
            this.setMiterLimit(value);
            break;
          case 'D':
            this.setDash(value[0], value[1]);
            break;
          case 'Font':
            this.setFont(value);
            break;
          case 'CA':
            this.setStrokeAlpha(value);
            break;
          case 'ca':
            this.setFillAlpha(value);
            break;
          case 'BM':
            this.current.blendMode = value;
            if (value != 'source-over')
              this.group.setAttributeNS(null, 'style', 
                                        'mix-blend-mode: ' + value);
            break;
          default:
            warn('Unimplemented graphic state ' + key);
            break;
        }
      }
    },

    fill: function SVGGraphics_fill() {
      var current = this.current;
      if (current.fillPatternId)
        current.element.setAttributeNS(null, 'fill', 
                                      'url(#' + (current.fillPatternId) + ')');
      else
        current.element.setAttributeNS(null, 'fill', current.fillColor);
      current.element.setAttributeNS(null, 'fill-opacity', current.fillAlpha);
      this.group.appendChild(current.element);
    },

    stroke: function SVGGraphics_stroke() {
      var current = this.current;

      if (current.strokePatternId)
        current.element.setAttributeNS(null, 'stroke',
                                      'url(#' + current.strokePatternId + ')');
      else
        current.element.setAttributeNS(null, 'stroke', current.strokeColor);
      current.element.setAttributeNS(null, 'stroke-opacity',
                                     current.strokeAlpha);
      current.element.setAttributeNS(null, 'stroke-miterlimit',
                                     pf(current.miterLimit));
      current.element.setAttributeNS(null, 'stroke-linecap', current.lineCap);
      current.element.setAttributeNS(null, 'stroke-linejoin', current.lineJoin);
      current.element.setAttributeNS(null, 'stroke-width',
                                     pf(current.lineWidth) + 'px');
      current.element.setAttributeNS(null, 'stroke-dasharray',
                                     current.dashArray.map(pf).join(' '));
      current.element.setAttributeNS(null, 'stroke-dashoffset',
                                     pf(current.dashPhase) + 'px');

      current.element.setAttributeNS(null, 'fill', 'none');
      this.group.appendChild(current.element);
    },

    eoFill: function SVGGraphics_eoFill() {
      this.current.element.setAttributeNS(null, 'fill-rule', 'evenodd');
      this.fill();
    },

    fillStroke: function SVGGraphics_fillStroke() {
      // Order is important since stroke wants fill to be none.
      // First stroke, then if fill needed, it will be overwritten.
      this.stroke();
      this.fill();
    },

    eoFillStroke: function SVGGraphics_eoFillStroke() {
      this.current.element.setAttributeNS(null, 'fill-rule', 'evenodd');
      this.fillStroke();
    },

    closeStroke: function SVGGraphics_closeStroke() {
      this.closePath();
      this.stroke();
    },

    closeFillStroke: function SVGGraphics_closeFillStroke() {
      this.closePath();
      this.fillStroke();
    },

    paintSolidColorImageMask:
        function SVGGraphics_paintSolidColorImageMask() {
      var current = this.current;
      var rect = this.svgFactory.createElement('svg:rect');
      rect.setAttributeNS(null, 'x', '0');
      rect.setAttributeNS(null, 'y', '0');
      rect.setAttributeNS(null, 'width', '1px');
      rect.setAttributeNS(null, 'height', '1px');
      rect.setAttributeNS(null, 'fill', current.fillColor);

      this.group.appendChild(rect);
    },

    paintJpegXObject: function SVGGraphics_paintJpegXObject(objId, w, h) {
      var imgObj = this.objs.get(objId);
      var imgEl = this.svgFactory.createElement('svg:image');
      imgEl.setAttributeNS(XLINK_NS, 'xlink:href', imgObj.src);
      imgEl.setAttributeNS(null, 'data-type', 'lossy');
      imgEl.setAttributeNS(null, 'width', pf(w));
      imgEl.setAttributeNS(null, 'height', pf(h));
      imgEl.setAttributeNS(null, 'x', '0');
      imgEl.setAttributeNS(null, 'y', pf(-h));
      imgEl.setAttributeNS(null, 'transform',
                           'scale(' + pf(1 / w) + ' ' + pf(-1 / h) + ')');

      this.group.appendChild(imgEl);
    },

    paintImageXObject: function SVGGraphics_paintImageXObject(objId) {
      var imgData = this.objs.get(objId);
      if (!imgData) {
        warn('Dependent image isn\'t ready yet');
        return;
      }
      this.paintInlineImageXObject(imgData, 0, objId);
    },

    paintInlineImageXObject:
        function SVGGraphics_paintInlineImageXObject(imgData, mask, objId) {
      var width = imgData.width;
      var height = imgData.height;

      var imgSrc;
      if (objId && this.objs.objs[objId].url) {
        imgSrc = this.objs.objs[objId].url;
      }
      else {
        imgSrc = convertImgData(imgData, this.forceDataSchema, !!mask);
        if (objId) {
          this.objs.objs[objId].url = imgSrc;
        }
      }
      var cliprect = this.svgFactory.createElement('svg:rect');
      cliprect.setAttributeNS(null, 'x', '0');
      cliprect.setAttributeNS(null, 'y', '0');
      cliprect.setAttributeNS(null, 'width', pf(width));
      cliprect.setAttributeNS(null, 'height', pf(height));
      this.current.element = cliprect;
      this.clip('nonzero');
      var imgEl = this.svgFactory.createElement('svg:image');
      imgEl.setAttributeNS(XLINK_NS, 'xlink:href', imgSrc);
      imgEl.setAttributeNS(null, 'x', '0');
      imgEl.setAttributeNS(null, 'y', pf(-height));
      imgEl.setAttributeNS(null, 'width', pf(width) + 'px');
      imgEl.setAttributeNS(null, 'height', pf(height) + 'px');
      imgEl.setAttributeNS(null, 'transform',
                           'scale(' + pf(1 / width) + ' ' +
                           pf(-1 / height) + ')');
      if (mask) {
        mask.appendChild(imgEl);
      } else {
        this.group.appendChild(imgEl);
      }
    },

    paintImageMaskXObject:
        function SVGGraphics_paintImageMaskXObject(imgData) {
      var current = this.current;
      var width = imgData.width;
      var height = imgData.height;
      var fillColor = current.fillColor;
      var mask = this.svgFactory.createElement('svg:mask');
      mask.id = 'mask' + (maskCount++);

      var rect = this.svgFactory.createElement('svg:rect');
      rect.setAttributeNS(null, 'x', '0');
      rect.setAttributeNS(null, 'y', '0');
      rect.setAttributeNS(null, 'width', pf(width));
      rect.setAttributeNS(null, 'height', pf(height));
      rect.setAttributeNS(null, 'fill', fillColor);
      rect.setAttributeNS(null, 'mask', 'url(#' + mask.id + ')');
      this.defs.appendChild(mask);

      this.group.appendChild(rect);
      this.paintInlineImageXObject(imgData, mask);
    },

    paintFormXObjectBegin:
        function SVGGraphics_paintFormXObjectBegin(matrix, bbox) {
      var matrix_text = pm(matrix);
      if (matrix_text)
        this.group.setAttributeNS(null, 'transform', matrix_text);
      if (Array.isArray(bbox) && bbox.length === 4) {
        var width = bbox[2] - bbox[0];
        var height = bbox[1] > bbox[3] ? bbox[1] - bbox[3] : 
                     bbox[3] - bbox[1];

        var cliprect = this.svgFactory.createElement('svg:rect');
        cliprect.setAttributeNS(null, 'x', bbox[0]);
        cliprect.setAttributeNS(null, 'y', bbox[1] > bbox[3] ? bbox[3] : bbox[1]);
        cliprect.setAttributeNS(null, 'width', pf(width));
        cliprect.setAttributeNS(null, 'height', pf(height));
        this.current.element = cliprect;
        this.clip('nonzero');
        this.endPath();
      }
    },

    paintFormXObjectEnd:
        function SVGGraphics_paintFormXObjectEnd() {},

    beginGroup: function SVGGraphics_beginGroup(args){
      if (args.smask && ['Alpha', 'Luminosity'].includes(args.smask.subtype)) {
        var matrix = args.matrix;
        var isolated = args.isolated;
        var mask = this.svgFactory.createElement('svg:mask');
        mask.id = 'mask' + (maskCount++);
        if (Array.isArray(args.matrix) && matrix.length === 6) {
          var matrix_text = pm(args.matrix);
          if (matrix_text)
            mask.setAttributeNS(null, 'transform', matrix_text);
        }
        var bbox = args.bbox;
        if (bbox && Array.isArray(bbox) && bbox.length == 4) {
        var width = bbox[2] - bbox[0];
        var height = bbox[1] > bbox[3] ? bbox[1] - bbox[3] : bbox[3] - bbox[1];
          mask.setAttributeNS(null, 'x', args.bbox[0]);
          mask.setAttributeNS(null, 'y', bbox[1] > bbox[3] ? bbox[3] : bbox[1]);
          mask.setAttributeNS(null, 'width', width);
          mask.setAttributeNS(null, 'height', height);
        }
        else {
          mask.setAttributeNS(null, 'x', '0');
          mask.setAttributeNS(null, 'y', '0');
          mask.setAttributeNS(null, 'width', '100%');
          mask.setAttributeNS(null, 'height', '100%');
        }
        mask.setAttributeNS(null, 'maskUnits', 'userSpaceOnUse');
        this.defs.appendChild(mask);
        this.current.maskedGroup = this.group;
        this.current.element = mask;
        this.group.setAttributeNS(null, 'mask', 'url(#' + mask.id + ')');
        this.group = mask;
      }
    },
    endGroup: function SVGGraphics_endGroup(args){
      if (this.current.strokeAlpha != 1 || this.current.fillAlpha != 1) {
        if (this.current.strokeAlpha == this.current.fillAlpha)
          this.group.setAttributeNS(null, 'opacity', this.current.fillAlpha);
        else {
          if (this.current.strokeAlpha != 1)
            this.group.setAttributeNS(null, 'stroke-opacity', this.current.strokeAlpha);
          if (this.current.fillAlpha != 1)
            this.group.setAttributeNS(null, 'fill-opacity', this.current.fillAlpha);
        }
      }
      if (args.smask && ['Alpha', 'Luminosity'].includes(args.smask.subtype)) {
        if (this.current.maskedGroup) {
          this.group = this.current.maskedGroup;
          if (args.smask.subtype == 'Alpha')
            this.group.style.maskMode = 'alpha';
          this.current.maskedGroup = null;
        }
      }
    },

    /**
     * @private
     */
    _initialize(viewport) {
      let svg = this.svgFactory.create(viewport.width, viewport.height);

      // Create the definitions element.
      let definitions = this.svgFactory.createElement('svg:defs');
      svg.appendChild(definitions);
      this.defs = definitions;

      // add a style to preserve multiple space characters (best supported way)
      var style = this.svgFactory.createElement('style');
      style.textContent = "tspan, text {white-space:pre;}";
      this.defs.appendChild(style);

      // Create the root group element, which acts a container for all other
      // groups and applies the viewport transform.
      let rootGroup = this.svgFactory.createElement('svg:g');
      rootGroup.setAttributeNS(null, 'transform', pm(viewport.transform));
      rootGroup.style.isolation = 'isolate';
      svg.appendChild(rootGroup);

      // For the construction of the SVG image we are only interested in the
      // root group, so we expose it as the entry point of the SVG image for
      // the other code in this class.
      this.group = rootGroup;

      return svg;
    },
  };
  return SVGGraphics;
})();

}

export {
  SVGGraphics,
};
