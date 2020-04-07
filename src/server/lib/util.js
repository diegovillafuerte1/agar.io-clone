/* jslint node: true */

'use strict';

var cfg = require('../../../config.json');
var SAT = require('sat');

exports.validNick = function(nickname) {
    var regex = /^\w*$/;
    return regex.exec(nickname) !== null;
};

// determine mass from radius of circle
exports.massToRadius = function (mass) {
    return 4 + Math.sqrt(mass) * 6;
};


// overwrite Math.log function
exports.log = (function () {
    var log = Math.log;
    return function (n, base) {
        return log(n) / (base ? log(base) : 1);
    };
})();

// get the Euclidean distance between the edges of two shapes
exports.getDistance = function (p1, p2) {
    return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2)) - p1.radius - p2.radius;
};

exports.randomInRange = function (from, to) {
    return Math.floor(Math.random() * (to - from)) + from;
};

// generate a random position within the field of play
exports.randomPosition = function (radius) {
    return {
        x: exports.randomInRange(radius, cfg.gameWidth - radius),
        y: exports.randomInRange(radius, cfg.gameHeight - radius)
    };
};

exports.uniformPosition = function(points, radius) {
    var bestCandidate, bestCandidateDistSq = 0;
    var numberOfCandidates = 10;

    function selectClosest(point) {
        var distSq = candidate.clone().sub(point).len2();
        if (distSq < minDistanceSq) {
            minDistanceSq = distSq;
        }
    }

    if (points.length === 0) {
        return exports.randomPosition(radius);
    }

    // Generate the candidates
    while (--numberOfCandidates >= 0) {
        var minDistanceSq = Number.MAX_VALUE;
        var candidate = new SAT.Vector().copy(exports.randomPosition(radius));

        points.forEach(selectClosest);

        if (minDistanceSq > bestCandidateDistSq) {
            bestCandidate = candidate;
            bestCandidateDistSq = minDistanceSq;
        }
    }

    return bestCandidate;
};

exports.findIndex = function(arr, id) {
    var len = arr.length;

    while (len--) {
        if (arr[len].id === id) {
            return len;
        }
    }

    return -1;
};

exports.randomColor = function() {
    var color = '#' + ('00000' + (Math.random() * (1 << 24) | 0).toString(16)).slice(-6);
    var c = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
    var r = (parseInt(c[1], 16) - 32) > 0 ? (parseInt(c[1], 16) - 32) : 0;
    var g = (parseInt(c[2], 16) - 32) > 0 ? (parseInt(c[2], 16) - 32) : 0;
    var b = (parseInt(c[3], 16) - 32) > 0 ? (parseInt(c[3], 16) - 32) : 0;

    return {
        fill: color,
        border: '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)
    };
};
