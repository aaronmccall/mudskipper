var Hoek = require('hoek');
var Inflection = require('inflection');

// Defaults for the methods
var internals = {
    routes: [],
    resources: {},
    dependencies: {},
    options: {},
    defaults: {
        index: {
            method: 'get'
        },
        show: {
            method: 'get'
        },
        create: {
            method: 'post',
            config: {
                payload: 'parse'
            }
        },
        update: {
            method: 'put',
            config: {
                payload: 'parse'
            }
        },
        patch: {
            method: 'patch',
            config: {
                payload: 'parse'
            }
        },
        destroy: {
            method: 'delete'
        }
    }
};

// a helper function to recurse through all the resources
// and save their dependencies so we can find children later
function saveDependencies(name, obj) {
    var child, childName;
    internals.dependencies[name] = { hasOne: [], hasMany: [] };

    function _parse(prop) {
        if (!Array.isArray(obj[prop])) obj[prop] = [obj[prop]];
        for (var i = 0, l = obj[prop].length; i < l; i++) {
            child = obj[prop][i];
            if (typeof child !== 'string') {
                Hoek.assert(Object.keys(child).length === 1, 'Child object must contain only one property');

                childName = Object.keys(child)[0];
                internals.dependencies[name][prop].push(childName);
                internals.resources[childName] = child[childName];
                internals.resources[childName].childOnly = true;
                saveDependencies(childName, child[childName]);
                delete internals.resources[childName].hasOne;
                delete internals.resources[childName].hasMany;
            } else {
                internals.dependencies[name][prop].push(obj[prop][i]);
            }
        }
    }

    if (obj.hasOne) _parse('hasOne');
    if (obj.hasMany) _parse('hasMany');
}

// the first pass goes through all keys, and makes sure that the hasOne
// and hasMany properties are arrays of strings. if objects are found,
// they are copied to internals.resources with the childOnly flag set
// to true, so as to prevent a top level route being created for them.
// all other objects are copied to internals.resources with the hasOne
// and hasMany keys removed.
function firstPass() {
    var key, resource, child, childName, i, l;

    for (key in internals.options) {
        if (key === 'uniqueIds') continue;
        resource = internals.options[key];
        internals.dependencies[key] = {};
        saveDependencies(key, resource);
        internals.resources[key] = resource;
        delete internals.resources[key].hasOne;
        delete internals.resources[key].hasMany;
    }

    secondPass();
}

// the second pass generates routes for all resources that
// have top level routes (i.e. the childOnly flag is *not* set)
// additionally, it ensures that methods for all resources are
// an object containing a handler property set to a function
function secondPass() {
    var key, resource, singular, method, settings, rootPath, objectPath, children, hasOneKeys, hasManyKeys;

    for (key in internals.resources) {
        resource = internals.resources[key];
        if (resource.childOnly) continue;
        children = findChildren(key);
        hasOneKeys = Object.keys(children.hasOne);
        hasManyKeys = Object.keys(children.hasMany);

        singular = Inflection.singularize(key);
        rootPath = [key];
        objectPath = internals.options.uniqueIds ? [key, '{' + singular + '_id}'] : [key, '{id}'];

        for (method in resource) {
            if (['index', 'create', 'show', 'update', 'patch', 'destroy'].indexOf(method) === -1) continue;

            if (typeof resource[method] === 'function') resource[method] = { handler: resource[method] };

            settings = Hoek.applyToDefaults(internals.defaults[method], resource[method]);
            if (resource[method].path) {
                if (resource[method].path.charAt(0) === '/') {
                    settings.path = resource[method].path;
                } else {
                    if (method === 'index' || method === 'create') {
                        settings.path = '/' + rootPath.join('/') + '/' + resource[method].path;
                    } else {
                        settings.path = '/' + objectPath.join('/') + '/' + resource[method].path;
                    }
                }
            } else {
                if (method === 'index' || method === 'create') {
                    settings.path = '/' + rootPath.join('/');
                } else {
                    settings.path = '/' + objectPath.join('/');
                }
            }
            settings.config = Hoek.applyToDefaults({ context: { hypermedia: {} } }, settings.config || {});
            settings.config.context.hypermedia.self = { link: '/' + rootPath.join('/') };
            settings.config.context.hypermedia.up = { link: '/' };
            settings.config.context.hypermedia.item = { link: '/' + objectPath.join('/') };
            var routeChildren = [];
            if (hasOneKeys.length) {
                hasOneKeys.forEach(function (k) {
                    routeChildren.push({ name: k, href: '/' + objectPath.join('/') + '/' + Inflection.singularize(k) });
                });
            }

            if (hasManyKeys.length) {
                hasManyKeys.forEach(function (k) {
                    routeChildren.push({ name: k, href: '/' + objectPath.join('/') + '/' + k });
                });
            }
            settings.config.context.hypermedia.children = routeChildren;
            internals.routes.push(settings);
        }

        if (hasOneKeys.length) {
            addChild(resource, objectPath, children.hasOne, true);
        }

        if (hasManyKeys.length) {
            addChild(resource, objectPath, children.hasMany, false);
        }
    }

    internals.plugin.route(internals.routes);
}

// a helper function to recursively find children from a given parent
function findChildren(parent, children, parents) {
    children = children || { hasOne: {}, hasMany: {} };
    parents = parents || [parent];
    if (!children.hasOne[parent] && !children.hasMany[parent]) children.hasOne[parent] = { hasOne: {}, hasMany: {} };
    var deps = internals.dependencies[parent];
    var child;

    function addChildren(prop) {
        for (var i = 0, l = deps[prop].length; i < l; i++) {
            if (parents.indexOf(deps[prop][i]) !== -1) continue;
            parents.push(deps[prop][i]);
            children[prop][deps[prop][i]] = findChildren(deps[prop][i], children[prop][parent], parents);
        }
    }

    if (deps) {
        if (deps.hasOne) addChildren('hasOne');
        if (deps.hasMany) addChildren('hasMany');
    }

    delete children.hasOne[parent];

    return children;
}

function addChild(parent, path, child, singular) {
    var i, l, childName, childSingular, settings, method, rootPath, objectPath, route, hasOneKeys, hasManyKeys;

    for (i = 0, l = Object.keys(child).length; i < l; i++) {
        childName = Object.keys(child)[i];
        hasOneKeys = Object.keys(child[childName].hasOne);
        hasManyKeys = Object.keys(child[childName].hasMany);
        childSingular = Inflection.singularize(childName);
        settings = Hoek.merge(internals.resources[childName], parent);
        rootPath = singular ? path.concat([childSingular]) : path.concat([childName]);
        if (singular) {
            objectPath = rootPath;
        } else {
            if (internals.options.uniqueIds) {
                objectPath = path.concat([childName, '{' + childSingular + '_id}']);
            } else {
                var subStr = '';
                path.join('').split('').forEach(function (character) {
                    if (character === '{') {
                        subStr += 'sub_';
                    }
                });
                subStr += 'id';
                objectPath = path.concat([childName, '{' + subStr + '}']);
            }
        }

        for (method in internals.resources[childName]) {
            if (['index', 'create', 'show', 'update', 'patch', 'destroy'].indexOf(method) === -1) continue;
            if (typeof internals.resources[childName][method] === 'function') internals.resources[childName][method] = { handler: internals.resources[childName][method] };

            route = Hoek.applyToDefaults(internals.defaults[method], settings[method]);

            if (singular) {
                if (method === 'index' || method === 'create') continue;
                route.path = '/' + rootPath.join('/');
            } else {
                if (method === 'index' || method === 'create') {
                    route.path = '/' + rootPath.join('/');
                } else {
                    route.path = '/' + objectPath.join('/');
                }
            }
            route.config = Hoek.applyToDefaults({ context: { hypermedia: {} } }, route.config || {});
            route.config.context.hypermedia.self = { link: '/' + rootPath.join('/') };
            route.config.context.hypermedia.up = { link: '/' + path.join('/') };
            route.config.context.hypermedia.item = { link: '/' + objectPath.join('/') };
            var routeChildren = [];
            if (hasOneKeys.length) {
                hasOneKeys.forEach(function (k) {
                    routeChildren.push({ name: k, href: '/' + objectPath.join('/') + '/' + Inflection.singularize(k) });
                });
            }

            if (hasManyKeys.length) {
                hasManyKeys.forEach(function (k) {
                    routeChildren.push({ name: k, href: '/' + objectPath.join('/') + '/' + k });
                });
            }
            route.config.context.hypermedia.children = routeChildren;
            internals.routes.push(route);
        }

        if (hasOneKeys.length) addChild(settings, objectPath, child[childName].hasOne, true);
        if (hasManyKeys.length) addChild(settings, objectPath, child[childName].hasMany, false);
    }
}

exports.register = function _register(plugin, options, next) {
    Hoek.assert(typeof options === 'object', 'Options must be defined as an object');
    Hoek.assert(Object.keys(options).length > 0, 'Options must contain at least one key');

    internals.plugin = plugin;
    internals.options = options;
    if (!internals.options.hasOwnProperty('uniqueIds')) internals.options.uniqueIds = true;
    firstPass();
    next();
};
