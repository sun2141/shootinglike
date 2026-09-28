import sys, pickle, json, numpy as np
import solve, fit3
J=pickle.load(open('jointpose2.pkl','rb'))
def jpose(f,W,H): return (J['R'],J['t'],J['C'],0.0)
fit3.pose=jpose
from fit3 import run, sim
from solve import proj
clips={'04':('/mnt/user-data/uploads/shooting-like/ref-rear/_work/t04b.json',[469.5,779.0],(42,118)),
       '05':('/mnt/user-data/uploads/shooting-like/ref-rear/_work/t05b.json',[458.3,766.6],(114,197))}
which=sys.argv[1]; f=J['f']; R,t,C=J['R'],J['t'],J['C']
trk=json.load(open(clips[which][0]))
arrival=None
if len(sys.argv)>2:
    uv=np.array([1407.2,457.0]); dc=np.array([(uv[0]-960)/f,(uv[1]-540)/f,1.0]); d=R.T@dc; s=-C[1]/d[1]; Pa=C+s*d
    arrival=(3.328,Pa,np.array([0.15,0.3,0.15])); print('arrival pt',Pa.round(2))
r=run(trk,np.array(clips[which][1]),f,7.44,2.5,clips[which][2],arrival=arrival)
c=r['cross']
print(which,'f',round(f),f"v0={r['speed']:.1f} elev={r['elev']:.1f} rms={r['rms']:.2f} k={r['k']:.4f} |aM|={np.linalg.norm(np.cross(r['spin'],r['v'])):.1f} t0={r['t0']:.3f} kick->goal line={-r['P0'][1]:.1f}m arr={r['arr'].round(2)}",
      (f"goal-line t={c[0]:.3f} x={c[1][0]:.2f} z={c[1][2]:.2f}" if c else 'no cross'))
ts,P=sim(r['P0'],r['v'],r['k'],r['spin'],2.2); uv=proj(f,R,t,P)
json.dump(dict(uv=uv[::5].tolist(),tt=(ts[::5]+r['t0']).tolist(),speed=r['speed'],elev=r['elev'],dist=float(-r['P0'][1])),open(f'traj4_{which}.json','w'))
