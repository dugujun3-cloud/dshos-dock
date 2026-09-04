window.__ModuleLoader__.load({
  id: "dshos-dock",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");

    function bar(props, children) {
      return react.createElement("div", props, children);
    }

    function DshosDock() {
      var statusState = react.useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];
      var errState = react.useState(false);
      var err = errState[0];
      var setErr = errState[1];
      react.useEffect(function () {
        var alive = true;
        function tick() {
          fetch("/dshos/status", { cache: "no-store" }).then(function (res) {
            if (!res.ok) throw new Error(String(res.status));
            return res.json();
          }).then(function (j) {
            if (!alive) return;
            setStatus(j);
            setErr(false);
          }).catch(function () {
            if (alive) setErr(true);
          });
        }
        tick();
        var t = setInterval(tick, 30000);
        return function () { alive = false; clearInterval(t); };
      }, []);

      var style = {
        display: "flex",
        justifyContent: "center",
        gap: 8,
        fontSize: "12px",
        color: "var(--dsw-alias-label-tertiary)",
        padding: "0 0 6px",
        flexWrap: "wrap"
      };

      if (err) {
        return bar({ style: style }, "dshos-dock: status unavailable");
      }
      if (!status) return null;

      if (status.ready === false) {
        return bar({ style: style }, "dshos-dock: not initialized — create .dshos/ in workspace (see README)");
      }

      var k = status.kernel || "dshos-dock";
      var tasks = status.tasks || {};
      var line = k + " · tasks " + tasks.total + " (running " + tasks.running + " / awaiting " + tasks.awaiting + ")";
      var events = status.events || [];
      if (events.length) {
        var last = events[events.length - 1];
        if (last && last.ts) line += " · last " + (last.event || "event") + " " + String(last.ts).slice(11, 19);
      }
      if (status.latestChecklist) line += " · checkup " + String(status.latestChecklist).split("T")[0];
      return bar({ style: style }, line);
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.input.dock", function () {
        return ctx.slots.register({
          name: "conversation.input.dock",
          id: "dshos",
          order: 5,
          inject: function () { return {}; }
        }, DshosDock);
      });
    }
    var inject = ["slots"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
