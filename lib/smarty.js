/*
 * pro-smarty, Embedded Express Template Engine
 * Copyright @2016-2017 projs.cn(pany@hywinsoft.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
*/

'use strict';

/**
 * Embedded express eemplate engine.
 *
 * @author williampany <pany@hywinsoft.com>
 * @project pro-smarty           n
 * @license {@link http://www.apache.org/licenses/LICENSE-2.0 Apache License, Version 2.0}
 *
 * @module smarty
 * @public
 */

var fs = require('fs');
var path = require('path');
var utils = require('./utils');

var scopeOptionWarned = false;
var _VERSION_STRING = require('../package.json').version;
var _DEFAULT_DELIMITER = '%';
var _DEFAULT_LOCALS_NAME = 'locals';
var _NAME = 'smarty';
var _REGEX_STRING = '(<%%|%%>|<%=|<%-|<%_|<%#|<%|%>|-%>|_%>)';
var _OPTS = ['delimiter', 'scope', 'context', 'debug', 'compileDebug',
    'client', '_with', 'rmWhitespace', 'strict', 'filename'];
// We don't allow 'cache' option to be passed in the data obj
// for the normal `render` call, but this is where Express puts it
// so we make an exception for `renderFile`
var _OPTS_EXPRESS = _OPTS.concat('cache');
var _BOM = /^\uFEFF/;

/**
 * smarty template function cache. This can be a LRU object from lru-cache NPM
 * module. By default, it is {@link module:utils.cache}, a simple in-process
 * cache that grows continuously.
 *
 * @type {Cache}
 */

exports.cache = utils.cache;

/**
 * Custom file loader. Useful for template preprocessing or restricting access
 * to a certain part of the filesystem.
 *
 * @type {fileLoader}
 */

exports.fileLoader = fs.readFileSync;

/**
 * Name of the object containing the locals.
 *
 * This variable is overridden by {@link Options}`.localsName` if it is not
 * `undefined`.
 *
 * @type {String}
 * @public
 */

exports.localsName = _DEFAULT_LOCALS_NAME;

/**
 * Get the path to the included file from the parent file path and the
 * specified path.
 *
 * @param {String}  name     specified path
 * @param {String}  filename parent file path
 * @param {Boolean} isDir    parent file path whether is directory
 * @return {String}
 */
exports.resolveInclude = function(name, filename, isDir) {

    var includePath = path.resolve(isDir ? filename : path.dirname(filename), name);
    var ext = path.extname(name);
    if (!ext) {
        includePath += '.html';
    }
    return includePath;
};

/**
 * Get the path to the included file by Options
 *
 * @param  {String}  path    specified path
 * @param  {Options} options compilation options
 * @return {String}
 */
function getIncludePath(path, options) {
    var includePath;
    var filePath;
    var views = options.views;

    // Absolute path
    if (path.charAt(0) == '/') {
        includePath = exports.resolveInclude(path.replace(/^\/*/,''), options.root || '/', true);
    }
    // Relative paths
    else {
        // Look relative to a passed filename first
        if (options.filename) {
            filePath = exports.resolveInclude(path, options.filename);
            if (fs.existsSync(filePath)) {
                includePath = filePath;
            }
        }
        // Then look in any views directories
        if (!includePath) {
            if (Array.isArray(views) && views.some(function (v) {
                    filePath = exports.resolveInclude(path, v, true);
                    return fs.existsSync(filePath);
                })) {
                includePath = filePath;
            }
        }
        if (!includePath) {
            throw new Error('Could not find include include file.');
        }
    }
    return includePath;
}

/**
 * Get the template from a string or a file, either compiled on-the-fly or
 * read from cache (if enabled), and cache the template if needed.
 *
 * If `template` is not set, the file specified in `options.filename` will be
 * read.
 *
 * If `options.cache` is true, this function reads the file from
 * `options.filename` so it must be set prior to calling this function.
 *
 * @memberof module:smarty-internal
 * @param {Options} options   compilation options
 * @param {String} [template] template source
 * @return {(TemplateFunction|ClientFunction)}
 * Depending on the value of `options.client`, either type might be returned.
 * @static
 */

function handleCache(options, template) {
    var func;
    var filename = options.filename;
    var hasTemplate = arguments.length > 1;

    if (options.cache) {
        if (!filename) {
            throw new Error('cache option requires a filename');
        }
        func = exports.cache.get(filename);
        if (func) {
            return func;
        }
        if (!hasTemplate) {
            template = fileLoader(filename).toString().replace(_BOM, '');
        }
    }
    else if (!hasTemplate) {
        // should not happen at all
        if (!filename) {
            throw new Error('Internal smarty error: no file name or template provided');
        }
        template = fileLoader(filename).toString().replace(_BOM, '');
    }
    func = exports.compile(template, options);
    if (options.cache) {
        exports.cache.set(filename, func);
    }
    return func;
}

/**
 * Try calling handleCache with the given options and data and call the
 * callback with the result. If an error occurs, call the callback with
 * the error. Used by renderFile().
 *
 * @memberof module:smarty-internal
 * @param {Options} options    compilation options
 * @param {Object} data        template data
 * @param {RenderFileCallback} callback callback
 * @static
 */

function tryHandleCache(options, data, callback) {
    var result;
    try {
        result = handleCache(options)(data);
    }
    catch (err) {
        return callback(err);
    }
    return callback(null, result);
}

/**
 * fileLoader is independent
 *
 * @param {String} filePath smarty file path.
 * @return {String} The contents of the specified file.
 * @static
 */

function fileLoader(filePath){
    return exports.fileLoader(filePath);
}

/**
 * Get the template function.
 *
 * If `options.cache` is `true`, then the template is cached.
 *
 * @memberof module:smarty-internal
 * @param {String}  path    path for the specified file
 * @param {Options} options compilation options
 * @return {(TemplateFunction|ClientFunction)}
 * Depending on the value of `options.client`, either type might be returned
 * @static
 */

function includeFile(path, options) {
    var opts = utils.shallowCopy({}, options);
    opts.filename = getIncludePath(path, opts);
    return handleCache(opts);
}

/**
 * Get the JavaScript source of an included file.
 *
 * @memberof module:smarty-internal
 * @param {String}  path    path for the specified file
 * @param {Options} options compilation options
 * @return {Object}
 * @static
 */

function includeSource(path, options) {
    var opts = utils.shallowCopy({}, options);
    var includePath;
    var template;
    includePath = getIncludePath(path, opts);
    template = fileLoader(includePath).toString().replace(_BOM, '');
    opts.filename = includePath;
    var templ = new Template(template, opts);
    templ.generateSource();
    return {
        source: templ.source,
        filename: includePath,
        template: template
    };
}