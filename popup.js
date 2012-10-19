window.addEventListener('load', function() {

  // Our default error handler.
  Asana.ServerModel.onError = function(response) {
    showError(response.errors[0].message);
  };

  // Ah, the joys of asynchronous programming.
  // To initialize, we've got to gather various bits of information.
  // Starting with a reference to the window and tab that were active when
  // the popup was opened ...
  chrome.windows.getCurrent(function(w) {
    chrome.tabs.query({
      active: true,
      windowId: w.id
    }, function(tabs) {
      // Now load our options ...
      Asana.ServerModel.options(function(options) {
        // And ensure the user is logged in ...
        Asana.ServerModel.isLoggedIn(function(is_logged_in) {
          if (is_logged_in) {
            showAddUi(options);
          } else {
            // The user is not even logged in. Prompt them to do so!
            showLogin(Asana.Options.loginUrl(options));
          }
        });
      });
    });
  });
});

// Helper to show a named view.
var showView = function(name) {
  ["login", "add", "success"].forEach(function(view_name) {
    $("#" + view_name + "_view").css("display", view_name === name ? "" : "none");
  });
};

// Helper to return sum of array elements.
var sum = function(arr) {
  return arr.reduce(function (a, b) { return a + b; }, 0);
}

// Show the add UI
var showAddUi = function(options) {
  var self = this;

  $("#center_pane").tabs();

  showView("add");
  Asana.ServerModel.me(function(user) {
    // Just to cache result.
    Asana.ServerModel.workspaces(function(workspaces) {
      $("#workspace").html("");
      workspaces.forEach(function(workspace) {
        $("#workspace").append(
            "<option value='" + workspace.id + "'>" + workspace.name + "</option>");
      });
      $("#workspace").val(options.default_workspace_id);
      onWorkspaceChanged().done(function() {
        $("#facets").selectable({
          selected: function(event, ui) {
            $(ui.selected).addClass('selected');
            onProjectChanged();
          },
          unselected: function(event, ui) {
            $(ui.unselected).removeClass('selected');
          }
        });
      });
      $("#workspace").change(onWorkspaceChanged);
    });
  });
};

// When the user changes the project, update the chart view.
var onProjectChanged = function() {
  var project_id = readProjectId(),
    dfd = $.Deferred();
  hideError();
  $("#gantt, #burndown").html("Loading...");
  Asana.ServerModel.projectTasks(project_id, function(tasks) {
    var minX = moment().valueOf();
    var reqs = tasks.map(function(task, i) {
      return Asana.ServerModel.task(task.id, function(record){
        var created = moment(record.created_at).startOf('day');
        task.estimateBase = 'human';
        if (record.due_on) {
          var due = moment(record.due_on).startOf('day');
          task.x = due.valueOf();
          task.estimate = Math.abs(created.diff(due));
          task.due = due.valueOf();
          task.estimateBase = 'due - created';
        } else {
          var estimate = moment.duration(7, 'd');
          task.x = created.add(estimate).valueOf();
          task.estimate = estimate.asMilliseconds();
          task.estimateBase = 'default';
        }
        task.created = created.valueOf();
        task.completed = record.completed_at ? moment(record.completed_at).startOf('day').valueOf() : null;
        task.assignee = record.assignee;
        task.size = 0; // required for scatter chart
        minX = Math.min(minX, task.x - task.estimate);
      })
    });

    $.when.apply($, reqs).then(function() {
      $("#gantt, #burndown").html("<svg></svg>");

      tasks.sort(function(a, b){
        return b.x - a.x;
      });

      // gantt chart
      var gantt = d3.nest().key(function(d){ return d.assignee ? d.assignee.name : 'nobody'; }).entries(tasks);
  
      nv.addGraph(function() {
        var chart = nv.models.scatterChart()
                      .color(d3.scale.category10().range());
      
        chart.xAxis
          .tickFormat(function(d) {
            return d3.time.format('%x')(new Date(d))
          });
        chart.yAxis.tickFormat(d3.format(''));
        chart.forceX([minX]);
        chart.useVoronoi(false);
        chart.tooltipContent(function(key, x, y, e, chart) {
          var d = e.point,
            html = ['<h3>', e.point.name, '</h3>',
              '<p><dl><dt>Created:</dt><dd>', moment(d.created).format('YYYY/M/D ddd'), '</dd>',
              '<dt>Due:</dt><dd>', d.due ? moment(d.due).format('YYYY/M/D ddd') : '-', '</dd>',
              '<dt>Estimate:</dt><dd>', moment.duration(d.estimate).humanize(), '(', d.estimateBase, ')</dd>'
              ];
          return html.join('');
        });

        var update = function() {
          d3.select('#gantt svg')
              .datum(gantt)
            .transition().duration(500)
              .call(chart)
            .each("end", function() {
              var x = chart.xScale(),
                y = chart.yScale(),
                r = 3;
 
              d3.selectAll('#gantt svg path.nv-point')
                .attr('d', function(d) {
                  var w = Math.abs(x(d.estimate) - x(0)),
                    points = [[0, r], [0, -r], [-w, -r], [-w, r]];
                  return d3.svg.line().interpolate('linear')(points) + 'Z';
                });
            });
        };

        update()
        nv.utils.windowResize(update);

        return chart;
      });

      // burndown chart
      var estimatePool = {},
        completedPool = {},
        dueDates = [],
        compDates = [],
        firstDay;
      tasks.forEach(function(d, i) {
        d.y = i;

        if (i == tasks.length - 1) {
          firstDay = moment(d.x).subtract('days', 1).valueOf();
        }

        if(!estimatePool[d.x]) {
          estimatePool[d.x] = [];
          dueDates.push(d.x);
        }
        estimatePool[d.x].push(d.estimate);

        if(!d.completed)
          return;

        if(!completedPool[d.completed]) {
          completedPool[d.completed] = [];
          compDates.push(d.completed);
        }
        completedPool[d.completed].push(d.estimate);
      });

      var estimates = [],
        outstandings = [],
        now = moment(),
        sumEstimate = 0,
        sumOutstanding;

      dueDates.forEach(function(d, i) {
        estimates.push({x: d, y: sumEstimate});
        sumEstimate += sum(estimatePool[d])
      });

      estimates.push({x: firstDay, y: sumEstimate});

      // burndown: outstanding
      sumOutstanding = sumEstimate;
      compDates.sort();
      if (compDates[0] < firstDay)
        firstDay = moment(compDates[0]).subtract('days', 1).valueOf();

      outstandings.push({x: firstDay, y: sumOutstanding});
      compDates.forEach(function(d){
        sumOutstanding -= sum(completedPool[d] || []);
        outstandings.push({x: d, y: sumOutstanding});
      });
      var today = moment().startOf('day').valueOf();
      outstandings.push({x: today, y: sumOutstanding});

      var burndown = [{values: estimates, key: 'Estimated', color: '#ff7f0e'}, {values: outstandings, key: 'Outstanding', color: '#2ca02c'}];
      nv.addGraph(function() {
        var chart = nv.models.lineChart();
      
        chart.xAxis
          .tickFormat(function(d) {
            return d3.time.format('%x')(new Date(d))
          });
        chart.yAxis.tickFormat(function(d) {
            return moment.duration(d).humanize();
        });
        chart.lines.scatter.useVoronoi(false);

        var update = function() {
          d3.select('#burndown svg')
              .datum(burndown)
            .transition().duration(500)
              .call(chart);
        };

        update()
        nv.utils.windowResize(update);

        return chart;
      });
      dfd.resolve();
    }); // $.when()
  }); // .projectTasks()
  return dfd.promise();
};

// When the user changes the workspace, update the list of projects.
var onWorkspaceChanged = function() {
  var workspace_id = readWorkspaceId(),
    dfd = $.Deferred();
  hideError();
  $("#facets").html("Loading...");
  Asana.ServerModel.projects(workspace_id, function(projects) {
    $("#facets").html("");
    projects = projects.sort(function(a, b) {
      return (a.name < b.name) ? -1 : ((a.name > b.name) ? 1 : 0);
    });
    var items = d3.select('#facets').selectAll('a.list-item').data(projects);
    items.enter()
      .append('a')
      .attr('class', 'list-item')
      .text(function(d) { return d.name; });

    items
      .text(function(d) {return d.name });

    items.exit()
      .remove();

    Asana.ServerModel.me(function(project) {
      items.each(function(d) {
        if (d.id === project.id)
          $(this).trigger('click');
      });
    });
    dfd.resolve();
  });
  return dfd.promise();
};

var readProjectId = function() {
  return d3.select("#facets .list-item.ui-selected").datum().id;
};

var readWorkspaceId = function() {
  return $("#workspace").val();
};

var showError = function(message) {
  console.log("Error: " + message);
  $("#error").css("display", "");
};

var hideError = function() {
  $("#error").css("display", "none");
};

// Helper to show the login page.
var showLogin = function(url) {
  $("#login_link").attr("href", url);
  $("#login_link").unbind("click");
  $("#login_link").click(function() {
    chrome.tabs.create({url: url});
    window.close();
    return false;
  });
  showView("login");
};
