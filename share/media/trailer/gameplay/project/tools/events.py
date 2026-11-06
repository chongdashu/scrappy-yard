import json,sys
for n in sys.argv[1:]:
    p=json.load(open(f'frames/{n}/per.json'))
    print('==',n,len(p),'first',p[0],'last',p[-1])
    for i in range(1,len(p)):
        a,b=p[i-1],p[i]; t=round(i/30,2); ev=[]
        if b[0]>a[0]: ev.append('nut')
        if b[1]>a[1]: ev.append('stumble')
        if a[3] and not b[3]: ev.append('jump')
        if not a[3] and b[3]: ev.append('land')
        if b[4]!=a[4]: ev.append(f'state {a[4]}->{b[4]}')
        if abs(b[6]-a[6])>0.05 and abs(p[i-2][6]-a[6])<=0.05 if i>1 else False: ev.append('strafe')
        if ev: print(t,ev,'rgap',round(b[5],2) if isinstance(b[5],(int,float)) else b[5])
