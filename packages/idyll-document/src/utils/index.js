const values = require('object.values');
const entries = require('object.entries');

const getNodesByName = (name, tree) => {
  const predicate = typeof name === 'string' ? (s) => s === name : name;

  const byName = (acc, val) => {
    if (typeof val === 'string') return acc;

    const [ name, attrs, children ] = val;

    if (predicate(name)) acc.push(val)

    if (children.length > 0) children.reduce(byName, acc)

    return acc;
  }

  return tree.reduce(
    byName,
    []
  )
}

export const evalExpression = (acc, expr) => {
  const e = `
    (() => {
      ${
        Object.keys(acc)
          .filter(key => expr.includes(key))
          .map(key => {
            if (key === 'refs') {
              // delete each ref's domNode property
              // because it can't be serialized
              values(acc[key]).forEach(v => {
                delete v.domNode;
              })
              // add `refs` const object graph to function scope
              return `var ${key} = JSON.parse('${JSON.stringify(acc[key])}')`;
            }
            return `var ${key} = ${JSON.stringify(acc[key])};`;
          })
          .join('\n')
      }
      return ${expr};
    })()
  `;

  try {
    return eval(e);
  } catch (err) {}
}

export const getVars = (arr, context = {}) => {
  const pluck = (acc, val) => {
    const [ , attrs, ] = val
    const [nameArr, valueArr] = attrs;

    const [, [, nameValue]] = nameArr
    const [, [valueType, valueValue]] = valueArr;

    switch(valueType) {
      case 'value':
        acc[nameValue] = valueValue;
        break;
      case 'variable':
        if (context.hasOwnProperty(valueValue)) {
          acc[nameValue] = context[valueValue];
        } else {
          acc[nameValue] = evalExpression(context, expr);
        }
        break;
      case 'expression':
        const expr = valueValue;
        acc[nameValue] = {
          value: evalExpression(context, expr),
          update: (newState, oldState) => {
            return evalExpression(Object.assign({}, oldState, newState), expr)
          }
        }
    }

    return acc;
  }

  return arr.reduce(
    pluck,
    {}
  )
}

export const getData = (arr, datasets = {}) => {
  const pluck = (acc, val) => {
    const [ , attrs, ] = val
    const [nameArr, ] = attrs;

    const [, [, nameValue]] = nameArr

    acc[nameValue] = datasets[nameValue];

    return acc;
  }

  return arr.reduce(
    pluck,
    {}
  )
}

export const splitAST = (ast) => {
  const state = {
    vars: [],
    derived: [],
    data: [],
    elements: [],
  }

  ast.forEach(node => {
    const [ name ] = node;
    if (name === 'var') {
      state.vars.push(node);
    } else if (state[name]) {
      state[name].push(node);
    } else {
      state.elements.push(node);
    }
  })

  return state;
}

export const hooks = [
  'onEnterView',
  'onEnterViewFully',
  'onExitView',
  'onExitViewFully',
  'onScroll',
];

export const translate = (arr) => {
  const attrConvert = (list) => {
    return list.reduce(
      (acc, [name, [type, val]]) => {
        if (type === 'variable') {
          acc.__vars__ = acc.__vars__ = {};
          acc.__vars__[name] = val;
        }
        // each node keeps a list of props that are expressions
        if (type === 'expression') {
          acc.__expr__ = acc.__expr__ || {};
          acc.__expr__[name] = val;
        }
        // flag nodes that define a hook function
        if (hooks.includes(name)) acc.hasHook = true;

        acc[name] = val
        return acc
      },
      {}
    )
  }

  const tNode = (node) => {
    if (typeof node === 'string') return node;

    if (node.length === 3) {
      const [ name, attrs, children ] = node

      return {
        component: name,
        ...attrConvert(attrs),
        children: children.map(tNode),
      }
    }
  }

  return splitAST(arr).elements.map(tNode)
}

export const mapTree = (tree, mapFn) => {
  const walkFn = (acc, node) => {
    if (typeof node !== 'string') {
      node.children = node.children.reduce(walkFn, [])
    }

    acc.push(mapFn(node))
    return acc;
  }

  return tree.reduce(
    walkFn,
    []
  )
}

export const findWrapTargets = (schema, state) => {
  const targets = [];
  const stateKeys = Object.keys(state);

  // always return node so we can walk the whole tree
  // but collect and ultimately return just the nodes
  // we are interested in wrapping
  mapTree(schema, (node) => {
    if (typeof node === 'string') return node;

    if (node.hasHook) {
      targets.push(node);
      return node;
    }

    // pull off the props we don't need to check
    const { component, children, __vars__, __expr__, ...props } = node;

    // iterate over the node's prop values
    entries(props).forEach(([key, val]) => {
      // avoid checking more props if we know it's a match
      if (targets.includes(node)) return;

      const valIncludes = val.includes ? val.includes.bind(val) : function(){};

      // include nodes whose prop value directly references a state var
      // like [Range value:x min:0 max:100 /]
      // or nodes that track refs
      // or nodes whose prop values include a state var ref
      // like [derived name:"xSquared" value:`x * x` /]
      if (
        stateKeys.includes(val) ||
        valIncludes('refs.') ||
        stateKeys.some(valIncludes)
      ) {
        targets.push(node);
      }
    });

    return node;
  })

  return targets;
}
