/*
 * jQuery Socket
 * http://github.com/flowersinthesand/jquery-socket
 * 
 * Copyright 2012, Donghwan Kim 
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
(function($, undefined) {
	
	var // Socket events
		socketEvents = "connecting open message close waiting".split(" "),
		// Sockets
		sockets = {},
		// Default options
		defaults = {},
		// Transports
		transports = {},
		// Reference to core prototype
		hasOwn = Object.prototype.hasOwnProperty;
	
	// A resettable callback
	function callbacks(flags) {
		var list = [],
			wrapper = {},
			wrapped = $.Callbacks(flags);
		
		$.each(wrapped, function(key) {
			wrapper[key] = function() {
				return wrapped[key].apply(this, arguments);
			};
		});
		
		return $.extend(wrapper, {
			add: function() {
				var args = arguments;
				
				if (!wrapped.disabled()) {
					$.merge(list, args);
				}
				
				return wrapped.add.apply(this, args); 
			},
			remove: function() {
				var i, j, args = arguments;
				
				if (!wrapped.disabled()) {
					for (i = 0; i < args.length; i++) {
						for (j = 0; j < list.length; j++) {
							if (args[i] === list[j]) {
								list.splice(j--, 1);
							}
						}
					}
				}
				
				return wrapped.remove.apply(this, args);
			},
			reset: function() {
				wrapped.disable();
				wrapped = $.Callbacks(flags);
				return wrapped.add.apply(this, list);
			}
		});
	}
	
	function isBinary(data) {
		var string = Object.prototype.toString.call(data);
		return string === "[object Blob]" || string === "[object ArrayBuffer]";
	}
	
	function isCrossDomain(url) {
		// From jQuery.ajax
		var parts = /^([\w\+\.\-]+:)(?:\/\/([^\/?#:]*)(?::(\d+))?)?/.exec(url.toLowerCase());
		return !!(parts && (parts[1] != location.protocol || parts[2] != location.hostname || (parts[3] || (parts[1] === "http:" ? 80 : 443)) != (location.port || (location.protocol === "http:" ? 80 : 443))));
	}
	
	function iterate(fn) {
		var timeoutId;
		
		// Though the interval is 1ms for real-time application, there is a delay between setTimeout calls
		// For detail, see https://developer.mozilla.org/en/window.setTimeout#Minimum_delay_and_timeout_nesting
		(function loop() {
			timeoutId = setTimeout(function() {
				if (fn() === false) {
					return;
				}
				
				loop();
			}, 1);
		})();
		
		return function() {
			clearTimeout(timeoutId);
		};
	}
		
	// Socket is based on The WebSocket API 
	// W3C Working Draft 29 September 2011 - http://www.w3.org/TR/2011/WD-websockets-20110929/
	function socket(url, options) {
		var // Transport
			transport,
			// Timeout
			timeoutTimer,
			// The state of the connection
			oldState,
			state,
			// Event helpers
			events = {},
			// Buffer
			buffer = [],
			// Reconnection
			reconnectTimer,
			reconnectDelay,
			reconnectTry,
			// Temporal object
			temp = {},
			// Socket object
			self = {
				// Original URL
				url: function() {
					return url;
				},
				// Final options object
				options: $.extend(true, {}, defaults, options),
				// Gets or sets a value
				data: function(key, value) {
					var ret = $(temp).data(key, value);
					return (ret && ret[0]) === temp ? this : ret || null;
				},
				// Returns the state
				state: function() {
					return state;
				},
				// Adds event handler
				on: function(type, fn) {
					var event = events[type];
					
					// For custom event
					if (!event) {
						if (events.message.disabled()) {
							return this;
						}
						
						event = events[type] = callbacks();
						event.order = events.message.order;
					}
					
					event.add(fn);
					
					return this;
				},
				// Removes event handler
				off: function(type, fn) {
					var event = events[type];
					
					if (event) {
						event.remove(fn);
					}
					
					return this;
				},
				// Adds one time event handler 
				one: function(type, fn) {
					var proxy = function() {
							self.off(type, proxy);
							fn.apply(this, arguments);
						};
					
					return self.on(type, proxy);
				},
				// Fires event handlers
				fire: function(type, args) {
					var event = events[type];
					
					if (event) {
						event.fireWith(self, args);
					}
					
					return this;
				},
				// Fire helper for transport
				notify: function(data, chunk) {
					if (chunk) {
						data = self.options.read.call(self, data);
						while (data && data.length) {
							self.notify(data.shift());
						}
						
						return this;
					}
					
					var events = isBinary(data) ? [{type: "message", data: data}] : $.makeArray(self.options.inbound.call(self, data)),
						i, event;
					
					for (i = 0; i < events.length; i++) {
						event = events[i];
						self.fire(event.type, event.args || [event.data]);
					}
					
					return this;
				},
				// Establishes a connection
				open: function() {
					var i = 0, 
						types = $.makeArray(self.options.type),
						url, type;
					
					// Cancels the scheduled connection
					if (reconnectTimer) {
						clearTimeout(reconnectTimer);
					}
					
					// Resets temporal object and event helpers
					temp = {};
					for (i in events) {
						events[i].reset();
					}
					
					// Chooses transport
					transport = undefined;
					self.data("transports", types);
					
					while (types.length) {
						type = types.shift();
						url = self.options.url.call(self, self.url(), type);
						self.data("url", url).data("crossDomain", isCrossDomain(url));
						
						transport = transports[type] && transports[type](self);
						if (transport) {
							// Fires connecting event
							self.data("transport", type).fire("connecting");
							transport.open();
							break;
						}
					}
					
					if (!transport) {
						self.close("notransport");
					}
					
					return this;
				},
				// Transmits data using the connection
				send: function(event, data) {
					if (state !== "opened") {
						buffer.push(arguments);
					} else if (transport) {
						if (data === undefined) {
							data = event;
							event = "message";
						}
						
						transport.send(self.data("transport") === "sub" || isBinary(data) ? data : self.options.outbound.call(self, {type: event, data: data}));
					}
					
					return this;
				},
				// Disconnects the connection
				close: function(reason) {
					var noFire;
					
					// Prevents reconnection
					self.options.reconnect = false;
					if (reconnectTimer) {
						clearTimeout(reconnectTimer);
					}
					
					if (transport) {
						noFire = transport.close();
					}
					
					// Fires close event
					if (!noFire) {
						self.fire("close", [reason || "close"]);
					}
					
					return this;
				},
				// Finds a sub socket communicating with this socket
				find: function(name) {
					return $.socket(url + "/" + name, {type: "sub", event: name, source: url});
				}
			};
		
		$.each(socketEvents, function(i, type) {
			// Creates event helper
			events[type] = callbacks(type === "message" ? "" : "once memory");
			events[type].order = i;
			
			// Shortcuts for on method
			var old = self[type],
				on = function(fn) {
					return self.on(type, fn);
				};
			
			self[type] = !old ? on : function(fn) {
				return ($.isFunction(fn) ? on : old).apply(this, arguments);
			};
		});
		
		// Initializes
		self.connecting(function() {
			state = "connecting";
			
			if (oldState === "connecting") {
				reconnectTry++;
			}
			
			// Sets timeout
			if (self.options.timeout > 0) {
				timeoutTimer = setTimeout(function() {
					self.close("timeout");
				}, self.options.timeout);
			}
		})
		.open(function() {
			state = "opened";
			
			// Clears timeout
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			
			// Disables connecting event
			events.connecting.disable();
			
			// Initializes variables related with reconnection
			reconnectTimer = reconnectDelay = reconnectTry = null;
			
			// Flushes buffer
			while (buffer.length) {
				self.send.apply(self, buffer.shift());
			}
		})
		.close(function() {
			oldState = state;
			state = "closed";
			
			var type, event, order = events.close.order;
			
			// Disables event whose order is lower than close event
			for (type in events) {
				event = events[type];
				if (event.order < order) {
					event.disable();
				}
			}
			
			// Handles reconnection
			if (self.options.reconnect) {
				self.one("close", function() {
					reconnectTry = reconnectTry || 1;
					reconnectDelay = self.options.reconnect(reconnectDelay || self.options.reconnectDelay, reconnectTry);
					
					if (reconnectDelay !== false) {
						reconnectTimer = setTimeout(self.open, reconnectDelay);
						self.fire("waiting", [reconnectDelay, reconnectTry]);
					}
				});
			}
		})
		.waiting(function() {
			state = "waiting";
		});
		
		return self.open();
	}
	
	// Default options
	$.extend(defaults, {
		type: "ws sse stream longpoll".split(" "),
		reconnectDelay: 500,
		reconnect: function(delay, attempts) {
			return attempts > 1 ? 2 * delay : 0;
		},
		inbound: function(data) {
			return $.parseJSON(data);
		},
		outbound: function(event) {
			event.socket = this.data("id");
			return $.stringifyJSON(event);
		},
		url: function(url, transport) {
			// UUID logic from http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript/2117523#2117523
			var id = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
				var r = Math.random() * 16 | 0,
					v = c === "x" ? r : (r & 0x3 | 0x8);
				
			    return v.toString(16);
			});
			
			// Stores the id
			this.data("id", id);
			
			// Attaches id and transport
			return url + (/\?/.test(url) ? "&" : "?") + $.param({id: id, transport: transport});
		},
		read: function(chunk) {
			var eol = /\r\n|\r|\n/g, lines = [], array = [], index = 0, 
				match, data, i, line;
			
			// String.prototype.split is not reliable cross-browser
			while (match = eol.exec(chunk)) {
			    lines.push(chunk.substring(index, match.index));
			    index = match.index + match[0].length;
			}
			lines.push(chunk.length === index ? "" : chunk.substring(index));
			
			data = this.data("data");
			if (!data) {
				data = [];
				this.data("data", data);
			}
			
			// Event stream format
			for (i = 0; i < lines.length; i++) {
				line = lines[i];
				if (!line) {
					array.push(data.join("\n"));
					data = [];
					this.data("data", data);
				} else if (/^data:\s/.test(line)) {
					data.push(line.substring(6));
				} else {
					data[data.length - 1] += line;
				}
			}
			
			if (array.length) {
				return array;
			}
		},
		// TODO rename and test
		enableXDR: false
	});
	
	// Transports
	$.extend(transports, {
		// Sub socket implementation
		sub: function(socket) {
			var // Event
				event = socket.options.event,
				// Source socket
				source = $.socket(socket.options.source);
			
			socket.options.timeout = 0;
			socket.options.reconnect = false;
			
			return {
				open: function() {
					if (!socket.options.init) {
						socket.options.init = true;
						
						source.open(function() {
							if (socket.state() === "closed") {
								socket.open();
							}
							
							socket.fire("open");
						})
						.close(function(reason) {
							socket.fire("close", [reason]);
						})
						.on(event, function(data) {
							socket.fire("message", [data]);
						});
					}
				},
				send: function(data) {
					source.send(event, data);
				},
				close: function() {
					socket.fire("close", ["close"]);
				}
			};
		},
		// WebSocket
		ws: function(socket) {
			var WebSocket = window.WebSocket || window.MozWebSocket,
				ws, url, aborted;
			
			if (!WebSocket) {
				return;
			}
			
			url = decodeURI($('<a href="' + socket.data("url") + '"/>')[0].href.replace(/^http/, "ws"));
			socket.data("url", url);

			return {
				open: function() {
					ws = new WebSocket(url);
					ws.onopen = function(event) {
						socket.data("event", event).fire("open");
					};
					ws.onmessage = function(event) {
						socket.data("event", event).notify(event.data);
					};
					ws.onerror = function(event) {
						socket.data("event", event).fire("close", ["error"]);
					};
					ws.onclose = function(event) {
						socket.data("event", event).fire.apply(socket, ["close", [event.wasClean ? "done" : aborted ? "close" : "error"]]);
					};
				},
				send: function(data) {
					ws.send(data);
				},
				close: function() {
					aborted = true;
					ws.close();
					return true;
				}
			};
		},
		// HTTP Support
		http: function(socket) {
			var queue = [], 
				sending;
			
			function post() {
				if (queue.length) {
					$.ajax(socket.url(), {type: "POST", data: queue.shift()}).always(post);
				} else {
					sending = false;
				}
			}
			
			return {
				send: function(data) {
					queue.push(data);
					
					if (!sending) {
						sending = true;
						post();
					}
				}
			};
		},
		// HTTP Streaming facade
		stream: function(socket) {
			var i, candidates = socket.data("transports");
			
			for (i in {xhr: 1, iframe: 1, xdr: 1}) {
				candidates.unshift("stream" + i);
			}
		},
		// HTTP Streaming - XMLHttpRequest
		streamxhr: function(socket) {
			var XMLHttpRequest = window.XMLHttpRequest, 
				xhr, stop, aborted;
			
			if (!XMLHttpRequest || (socket.data("crossDomain") && !$.support.cors)) {
				return;
			}
			
			xhr = new XMLHttpRequest();
			xhr.onreadystatechange = function() {
				var index, length,
					onchunk = function() {
						index = socket.data("index");
						length = xhr.responseText.length;
						
						if (!index) {
							socket.fire("open");
						} else if (length > index) {
							socket.notify(xhr.responseText.substring(index, length), true);
						}
						
						socket.data("index", length);
					};
				
				switch (xhr.readyState) {
				case 3:
					if (xhr.status === 200) {
						if ($.browser.opera && !stop) {
							stop = iterate(onchunk);
						} else {
							onchunk();
						}
					}
					break;
				case 4:
					if (stop) {
						stop();
					}
					
					socket.fire.apply(socket, ["close", [xhr.status === 200 ? "done" : aborted ? "close" : "error"]]);
					break;
				}
			};
			
			return $.extend(transports.http(socket), {
				open: function() {
					xhr.open("GET", socket.data("url"));
					xhr.send(null);
				},
				close: function() {
					var readyState = xhr.readyState;
					
					aborted = true;
					xhr.abort();
					
					return readyState > 2;
				}
			});
		},
		// HTTP Streaming - Iframe
		streamiframe: function(socket) {
			var ActiveXObject = window.ActiveXObject,
				doc, stop, iframe, cdoc;
			
			if (!ActiveXObject || socket.data("crossDomain")) {
				return;
			}
			
			doc = new ActiveXObject("htmlfile");
			doc.open();
			doc.close();
			
			iframe = doc.createElement("iframe");
			
			return $.extend(transports.http(socket), {
				open: function() {
					var response;
					
					iframe.src = socket.data("url");
					doc.body.appendChild(iframe);
					
					cdoc = iframe.contentDocument || iframe.contentWindow.document;
					stop = iterate(function() {
						if (!cdoc.firstChild) {
							return;
						}
						
						// Detects connection failure
						if (cdoc.readyState === "complete") {
							try {
								// Meaningless
								response = cdoc.fileSize;
							} catch(e) {
								socket.fire("close", ["error"]);
								return false;
							}
						}
						
						response = cdoc.body.lastChild;
						response.innerText = "";
						socket.fire("open");
						
						stop = iterate(function() {
							var clone = response.cloneNode(true), 
								text;

							clone.appendChild(cdoc.createTextNode("."));
							text = clone.innerText;
							text = text.substring(0, text.length - 1);
							
							if (text) {
								response.innerText = "";
								socket.notify(text, true);
							}
	
							if (cdoc.readyState === "complete") {
								socket.fire("close", ["done"]);
								return false;
							}
						});
						
						return false;
					});
				},
				close: function() {
					if (stop) {
						stop();
					}
					
					doc.execCommand("Stop");
				}
			});
		},
		// HTTP Streaming - XDomainRequest
		streamxdr: function(socket) {
			var XDomainRequest = window.XDomainRequest,
				xdr, url;
			
			if (!XDomainRequest || !socket.options.enableXDR) {
				return;
			}
			
			function rewriteURL(url) {
				// Maintaining session by rewriting URL
				// http://stackoverflow.com/questions/6453779/maintaining-session-by-rewriting-url
				var name, match, 
					rewriters = {
						JSESSIONID: function(sid) {
							return url.replace(/;jsessionid=[^\?]*|(\?)|$/, ";jsessionid=" + sid + "$1");
						},
						PHPSESSID: function(sid) {
							return url.replace(/\?PHPSESSID=[^&]*&?|\?|$/, "?PHPSESSID=" + sid + "&").replace(/&$/, "");
						}
					};
				
				for (name in rewriters) {
					// Finds session id from cookie
					match = new RegExp("(?:^|;\\s*)" + encodeURIComponent(name) + "=([^;]*)").exec(document.cookie);
					if (match) {
						return rewriters[name](match[1]);
					}
				}
				
				return url;
			}
			
			url = rewriteURL(socket.data("url"));
			socket.data("url", url);
			
			xdr = new XDomainRequest();
			xdr.onprogress = function() {
				var index = socket.data("index"), 
					length = xdr.responseText.length;
				
				if (!index) {
					socket.fire("open");
				} else {
					socket.notify(xdr.responseText.substring(index, length), true);
				}
				
				socket.data("index", length);
			};
			xdr.onerror = function() {
				socket.fire("close", ["error"]);
			};
			xdr.onload = function() {
				socket.fire("close", ["done"]);
			};
			
			return $.extend(transports.http(socket), {
				open: function() {
					xdr.open("GET", url);
					xdr.send();
				},
				close: function() {
					xdr.abort();
				}
			});
		},
		// Server-Sent Events
		sse: function(socket) {
			var EventSource = window.EventSource,
				es;
			
			if (!EventSource || socket.data("crossDomain")) {
				return;
			}
			
			return $.extend(transports.http(socket), {
				open: function() {
					es = new EventSource(socket.data("url"));
					es.onopen = function(event) {
						socket.data("event", event).fire("open");
					};
					es.onmessage = function(event) {
						socket.data("event", event).notify(event.data);
					};
					es.onerror = function(event) {
						es.close();
						
						// There is no way to find whether this connection closed normally or not 
						socket.data("event", event).fire("close", ["done"]);
					};
				},
				close: function() {
					es.close();
				}
			});
		},
		// Long Polling facade
		longpoll: function(socket) {
			var i, candidates = socket.data("transports");
			
			for (i in {jsonp: 1, xhr: 1}) {
				candidates.unshift("longpoll" + i);
			}
		},
		// Long Polling - XMLHttpRequest
		longpollxhr: function(socket) {
			var count = 1, url = socket.data("url"), 
				xhr;
			
			if (!$.support.ajax || (socket.data("crossDomain") && !$.support.cors)) {
				return;
			}
			
			function poll() {
				var u = url + (/\?/.test(url) ? "&" : "?") +  $.param({count: count++});
				
				socket.data("url", u);
				
				xhr = $.ajax(u, {type: "GET", dataType: "text", async: true, cache: true, timeout: 0})
				.done(function(data) {
					if (xhr.status === 200) {
						if (data) {
							socket.notify(data);
							poll();
						} else {
							socket.fire("close", ["done"]);
						}
					} else {
						socket.fire("close", ["error"]);
					}
				})
				.fail(function(jqXHR, reason) {
					socket.fire("close", [reason === "abort" ? "close" : "error"]);
				});
			}
			
			return $.extend(transports.http(socket), {
				open: function() {
					poll();
					
					setTimeout(function() {
						socket.fire("open");
					}, 10);
				},
				close: function() {
					xhr.abort();
					return true;
				}
			});
		},
		// Long Polling - JSONP
		longpolljsonp: function(socket) {
			var count = 1, url = socket.data("url"), callback = $.expando + "_" + socket.data("id").replace(/-/g, ""),
				xhr, called;
			
			function poll() {
				var u = url + (/\?/.test(url) ? "&" : "?") +  $.param({callback: callback, count: count++});
				
				socket.data("url", u);
				
				xhr = $.ajax(u, {dataType: "script", crossDomain: true, cache: true, timeout: 0})
				.done(function() {
					if (called) {
						called = false;
						poll();
					} else {
						socket.fire("close", ["done"]);
					}
				})
				.fail(function(jqXHR, reason) {
					socket.fire("close", [reason === "abort" ? "close" : "error"]);
				});
			}
			
			return $.extend(transports.http(socket), {
				open: function() {
					window[callback] = function(data) {
						called = true;
						socket.notify(data);
					};
					socket.one("close", function() {
						window[callback] = undefined;
					});
					
					poll();
					
					setTimeout(function() {
						socket.fire("open");
					}, 10);
				},
				close: function() {
					xhr.abort();
					return true;
				}
			});
		}
	});
	
	// Closes all socket when the document is unloaded 
	$(window).on("unload.socket", function() {
		var url, socket;
		
		for (url in sockets) {
			socket = sockets[url];
			if (socket.state() !== "closed") {
				socket.close();
			}
		}
		
		sockets = {};
	});
	
	$.socket = function(url, options) {
		var i;
		
		// Returns the first socket in the document
		if (!url) {
			for (i in sockets) {
				if (hasOwn.call(sockets, i)) {
					return sockets[i];
				}
			}
			return null;
		}
		
		// Socket to which the given url is mapped
		if (hasOwn.call(sockets, url)) {
			return sockets[url];
		}
		
		// The url is a identifier of this socket within the document
		return (sockets[url] = socket(url, options));
	};
	
	$.socket.defaults = defaults;
	$.socket.transports = transports;
	
})(jQuery);

/*
 * jQuery stringifyJSON
 * http://github.com/flowersinthesand/jquery-stringifyJSON
 * 
 * Copyright 2011, Donghwan Kim 
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
// This plugin is heavily based on Douglas Crockford's reference implementation
(function($) {
	
	var escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g, 
		meta = {
			'\b' : '\\b',
			'\t' : '\\t',
			'\n' : '\\n',
			'\f' : '\\f',
			'\r' : '\\r',
			'"' : '\\"',
			'\\' : '\\\\'
		};
	
	function quote(string) {
		return '"' + string.replace(escapable, function(a) {
			var c = meta[a];
			return typeof c === "string" ? c : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
		}) + '"';
	}
	
	function f(n) {
		return n < 10 ? "0" + n : n;
	}
	
	function str(key, holder) {
		var i, v, len, partial, value = holder[key], type = typeof value;
				
		if (value && typeof value === "object" && typeof value.toJSON === "function") {
			value = value.toJSON(key);
			type = typeof value;
		}
		
		switch (type) {
		case "string":
			return quote(value);
		case "number":
			return isFinite(value) ? String(value) : "null";
		case "boolean":
			return String(value);
		case "object":
			if (!value) {
				return "null";
			}
			
			switch (Object.prototype.toString.call(value)) {
			case "[object Date]":
				return isFinite(value.valueOf()) ? '"' + value.getUTCFullYear() + "-" + f(value.getUTCMonth() + 1) + "-" + f(value.getUTCDate()) + "T" + 
						f(value.getUTCHours()) + ":" + f(value.getUTCMinutes()) + ":" + f(value.getUTCSeconds()) + "Z" + '"' : "null";
			case "[object Array]":
				len = value.length;
				partial = [];
				for (i = 0; i < len; i++) {
					partial.push(str(i, value) || "null");
				}
				
				return "[" + partial.join(",") + "]";
			default:
				partial = [];
				for (i in value) {
					if (Object.prototype.hasOwnProperty.call(value, i)) {
						v = str(i, value);
						if (v) {
							partial.push(quote(i) + ":" + v);
						}
					}
				}
				
				return "{" + partial.join(",") + "}";
			}
		}
	}
	
	$.stringifyJSON = function(value) {
		if (window.JSON && window.JSON.stringify) {
			return window.JSON.stringify(value);
		}
		
		return str("", {"": value});
	};
	
}(jQuery));